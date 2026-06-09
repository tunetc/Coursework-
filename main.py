import asyncio
import json
import logging
import time
import os
from typing import List, Dict, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Steam & DMarket Decentralized Aggregator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PRICE_CACHE: Dict[str, dict] = {}
CACHE_TTL_SECONDS = 1200 

SKINS_DATABASE: List[str] = []
FILE_PATH = 'cs2_skins.json'

PARSING_QUEUE: asyncio.Queue = asyncio.Queue()

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    file_path = "client/index.html"
    if not os.path.exists(file_path):
        logger.error(f"❌ Фронтенд-файл '{file_path}' не знайдено! Перевірте структуру папок.")
        return HTMLResponse(
            content="<h1>Внутрішня помилка сервера</h1><p>Файл client/index.html відсутній.</p>", 
            status_code=404
        )
    with open(file_path, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), status_code=200)

if os.path.exists("client"):
    app.mount("/client", StaticFiles(directory="client"), name="client")

class RawMarketInput(BaseModel):
    market_name: str
    raw_price: float = Field(..., description="Мінімальна або поточна брутто-ціна з API")

class ClientPayload(BaseModel):
    market_hash_name: str
    raw_prices: List[RawMarketInput]

class MarketPriceInfo(BaseModel):
    market_name: str
    raw_price: float
    commission: float
    net_price: float

class ArbitrageOpportunity(BaseModel):
    market_hash_name: str
    source_market: str
    target_market: str
    buy_price: float
    sell_net_price: float
    profit_percentage: float

class AnalyticsResponse(BaseModel):
    market_hash_name: str
    processed_prices: List[MarketPriceInfo]
    arbitrage_opportunities: List[ArbitrageOpportunity]
    from_cache: bool = False

def get_commission_rate(market_name: str) -> float:
    """Повертає точну комісію системи для фінансового очищення цін."""
    commissions = {
        "Steam": 0.1304,    # ~13.04% комісія Valve на предмети CS2
        "DMarket": 0.07,    # 7% базова комісія DMarket
        "Skinport": 0.05    # 5% комісія Skinport
    }
    return commissions.get(market_name, 0.10)


def calculate_arbitrage(market_hash_name: str, prices: List[MarketPriceInfo]) -> List[ArbitrageOpportunity]:
    """Шукає вигідні міжбіржові комбінації з профітом > 2%."""
    opportunities = []
    for source in prices:
        for target in prices:
            if source.market_name == target.market_name:
                continue
            
            profit_raw = target.net_price - source.raw_price
            profit_percent = (profit_raw / source.raw_price) * 100
            
            if profit_percent > 2.0:
                opportunities.append(
                    ArbitrageOpportunity(
                        market_hash_name=market_hash_name,
                        source_market=source.market_name,
                        target_market=target.market_name,
                        buy_price=source.raw_price,
                        sell_net_price=target.net_price,
                        profit_percentage=round(profit_percent, 2)
                    )
                )
    return opportunities


@app.get("/api/v1/search-skins", response_model=List[str])
async def search_skins(query: str = ""):
    if not query or not query.strip():
        return []
    
    query_clean = " ".join(query.strip().split()).lower()
    query_words = query_clean.split()
    matches = []
    
    try:
        for skin in SKINS_DATABASE:
            skin_lower = skin.lower()
            if all(word in skin_lower for word in query_words):
                matches.append(skin)
            if len(matches) >= 10:
                break
    except Exception as e:
        logger.error(f"Помилка пошукового рушія: {str(e)}")
        raise HTTPException(status_code=500, detail="Внутрішня помилка пошуку")
            
    return matches


@app.get("/api/v1/get-parsing-task")
async def get_parsing_task():
    if PARSING_QUEUE.empty():
        return {"task_available": False, "market_hash_name": None}
    
    skin_task = await PARSING_QUEUE.get()
    logger.info(f"🤖 Оркестратор: Задача [{skin_task}] видана воркеру та вилучена з черги.")
    return {"task_available": True, "market_hash_name": skin_task}


@app.get("/api/v1/check-cache", response_model=Optional[AnalyticsResponse])
async def check_cache(market_hash_name: str):
    cache_entry = PRICE_CACHE.get(market_hash_name)
    
    if cache_entry:
        current_time = time.time()
        elapsed_time = current_time - cache_entry["timestamp"]
        
        if elapsed_time < CACHE_TTL_SECONDS:
            logger.info(f" Найдено актуальний серверний кеш для: '{market_hash_name}'")
            analytics_data = cache_entry["data"]
            analytics_data.from_cache = True
            return analytics_data
        else:
            logger.info(f" Кеш для '{market_hash_name}' застарів. Видаляємо.")
            del PRICE_CACHE[market_hash_name]
            
    return None


@app.post("/api/v1/process-analytics", response_model=AnalyticsResponse)
async def process_client_data(payload: ClientPayload):
    try:
        logger.info(f" Синхронізація з ринком. Кешування даних для: {payload.market_hash_name}")
        
        processed_prices = []
        for item in payload.raw_prices:
            comm = get_commission_rate(item.market_name)
            net = round(item.raw_price * (1 - comm), 2)
            processed_prices.append(
                MarketPriceInfo(
                    market_name=item.market_name,
                    raw_price=item.raw_price,
                    commission=comm,
                    net_price=net
                )
            )
            
        deals = calculate_arbitrage(payload.market_hash_name, processed_prices)
        
        response_data = AnalyticsResponse(
            market_hash_name=payload.market_hash_name,
            processed_prices=processed_prices,
            arbitrage_opportunities=deals,
            from_cache=False
        )
        
        PRICE_CACHE[payload.market_hash_name] = {
            "timestamp": time.time(),
            "data": response_data
        }
        
        async def re_queue_task(skin_name: str, delay: int):
            await asyncio.sleep(delay) 
            await PARSING_QUEUE.put(skin_name)
            logger.info(f"⏳ Черга: Термін дії кешу для [{skin_name}] закінчився. Повертаємо в чергу задач.")

        asyncio.create_task(re_queue_task(payload.market_hash_name, CACHE_TTL_SECONDS))
        
        return response_data
        
    except Exception as e:
        logger.error(f"Критична помилка обробки аналітики: {str(e)}")
        raise HTTPException(status_code=500, detail="Внутрішня помилка сервера при аналізі фінансових даних")


@app.get("/api/v1/mass-cache", response_model=List[dict])
async def get_all_valid_cache():
    valid_records = []
    current_time = time.time()
    
    for skin_name, cache_entry in list(PRICE_CACHE.items()):
        elapsed_time = current_time - cache_entry["timestamp"]
        if elapsed_time < CACHE_TTL_SECONDS:
            analytics = cache_entry["data"]
            valid_records.append({
                "market_hash_name": skin_name,
                "prices": [p.model_dump() for p in analytics.processed_prices],
                "deals_count": len(analytics.arbitrage_opportunities)
            })
        else:
            del PRICE_CACHE[skin_name]
            
    return valid_records


@app.get("/api/v1/skins-list", response_model=List[str])
async def get_skins_list():
    return SKINS_DATABASE


@app.on_event("startup")
async def load_skins_schema():
    global SKINS_DATABASE
    wear_names = ["Factory New", "Minimal Wear", "Field-Tested", "Well-Worn", "Battle-Scarred"]
    skins = []
    
    try:
        with open(FILE_PATH, 'r', encoding='utf-8') as file:
            skins = json.load(file)
        logger.info(f" Файл '{FILE_PATH}' успішно прочитано. Знайдено {len(skins)} базових записів.")
    except (FileNotFoundError, json.JSONDecodeError):
        logger.error("❌ Критична помилка зчитування JSON бази! Активовано fallback-список.")
    
    try:
        generated_full_db = set()
        if isinstance(skins, list) and len(skins) > 0:
            for item in skins:
                if not isinstance(item, dict): continue
                base_name = item.get("base_market_hash_name")
                if not base_name and item.get("weapon_type") and item.get("skin_name"):
                    base_name = f"{item['weapon_type']} | {item['skin_name']}"
                
                if base_name:
                    base_name = base_name.strip()
                    if "|" in base_name or "Zeus" in base_name:
                        for wear in wear_names:
                            full_skin_name = f"{base_name}  ({wear})" if "Zeus" in base_name else f"{base_name} ({wear})"
                            generated_full_db.add(full_skin_name)
                            generated_full_db.add(f"StatTrak™ {full_skin_name}")
                    else:
                        generated_full_db.add(base_name)
        
        if generated_full_db:
            SKINS_DATABASE = sorted(list(generated_full_db))
            logger.info(f"✅ Базу скінів сформовано. Створено {len(SKINS_DATABASE)} комбінацій.")
            
            for task_skin in SKINS_DATABASE:
                await PARSING_QUEUE.put(task_skin)
                
            logger.info(f"🤖 Оркестратор: Усі {PARSING_QUEUE.qsize()} задач успішно додано в чергу асинхронного парсингу.")
        else:
            raise Exception("Масив порожній.")
            
    except Exception as e:
        fallback_list = [
            "AK-47 | Redline (Field-Tested)", "AK-47 | Redline (Minimal Wear)",
            "StatTrak™ AK-47 | Redline (Field-Tested)", "AWP | Asiimov (Field-Tested)"
        ]
        SKINS_DATABASE = fallback_list
        for task_skin in fallback_list:
            await PARSING_QUEUE.put(task_skin) 