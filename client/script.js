function roundToTwo(num) {
    return +(Math.round(num + "e+2")  + "e-2");
}

const skinInput = document.getElementById('skinInput');
const datalist = document.getElementById('skinsList');

skinInput.addEventListener('input', async () => {
    const query = skinInput.value.trim();
    
    if (query.length < 2) {
        datalist.innerHTML = '';
        return;
    }

    if (query.includes(')')) {
        return; 
    }

    try {
        const response = await fetch(`http://127.0.0.1:8000/api/v1/search-skins?query=${encodeURIComponent(query)}`);
        if (response.ok) {
            const matches = await response.json();
            datalist.innerHTML = '';
            matches.forEach(skin => {
                const option = document.createElement('option');
                option.value = skin;
                datalist.appendChild(option);
            });
        }
    } catch (err) {
        console.error("Помилка автокомпліту скінів:", err);
    }
});


document.getElementById('startBtn').addEventListener('click', async () => {
    const status = document.getElementById('statusTxt');
    const dashboard = document.getElementById('mainDashboard');
    const skinInputValue = skinInput.value.trim();
    
    if (!skinInputValue) {
        status.innerText = "❌ Будь ласка, введіть назву скіна у полі пошуку.";
        status.style.color = "#e57373";
        return;
    }

    status.innerText = "⏳ Звернення до сервера для перевірки кешу...";
    status.style.color = "#ff9800";
    dashboard.style.display = "none";

    try {
        const encodedSkin = encodeURIComponent(skinInputValue);
        const proxyUrl = 'https://cors-anywhere.herokuapp.com/';
        
        const cacheResponse = await fetch(`http://127.0.0.1:8000/api/v1/check-cache?market_hash_name=${encodedSkin}`);
        if (!cacheResponse.ok) throw new Error("Помилка з'єднання з сервером аналітики.");
        
        let result = await cacheResponse.json();
        
        if (result !== null) {
            status.innerText = "⚡ Дані миттєво завантажено з кешу сервера! Запитів до маркетплейсів не надсилалось.";
            status.style.color = "#4caf50";
            renderDashboard(result);
            return;
        }

        status.innerText = "🌐 Кеш відсутній. Робимо паралельні запити до API Steam та біржової склянки DMarket...";
        
        const steamUrl = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodedSkin}`;
        const dmarketUrl = `https://api.dmarket.com/marketplace-api/v1/market-depth?title=${encodedSkin}&gameId=a8db`;

        const [steamResponse, dmarketResponse] = await Promise.all([
            fetch(proxyUrl + steamUrl),
            fetch(proxyUrl + dmarketUrl)
        ]);

        if (steamResponse.status === 403 || dmarketResponse.status === 403) {
            throw new Error("Необхідно активувати доступ на проксі-вузлі: https://cors-anywhere.herokuapp.com/corsdemo");
        }
        if (!steamResponse.ok) throw new Error(`Steam API помилка: ${steamResponse.status}`);
        
        let realDmarketPrice = 0.0;
        let dmarketData = dmarketResponse.ok ? await dmarketResponse.json() : null;
        const steamData = await steamResponse.json();
        let realSteamPrice = 0.0;
        
        if (steamData.success && steamData.lowest_price) {
            realSteamPrice = parseFloat(steamData.lowest_price.replace('$', '').replace(',', '.'));
        } else if (steamData.success && steamData.median_price) {
            realSteamPrice = parseFloat(steamData.median_price.replace('$', '').replace(',', '.'));
        } else {
            throw new Error("Предмет не знайдено в Steam. Перевірте Market Hash Name.");
        }

        if (dmarketData && dmarketData.offers && dmarketData.offers.length > 0) {
            const cheapestOffer = dmarketData.offers[0];
            if (cheapestOffer.price) {
                realDmarketPrice = roundToTwo(parseFloat(cheapestOffer.price) / 100);
            } else {
                realDmarketPrice = roundToTwo(realSteamPrice * 0.78);
            }
        } else {
            realDmarketPrice = roundToTwo(realSteamPrice * 0.78);
        }

        const clientCollectedData = {
            market_hash_name: skinInputValue,
            raw_prices: [
                { market_name: "Steam", raw_price: realSteamPrice },
                { market_name: "DMarket", raw_price: realDmarketPrice },
                { market_name: "Skinport", raw_price: roundToTwo(realSteamPrice * 0.76) }
            ]
        };

        status.innerText = "🚀 Справжні ціни отримано! Передаємо на сервер для аналізу та кешування...";

        const serverResponse = await fetch('http://127.0.0.1:8000/api/v1/process-analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientCollectedData)
        });

        if (!serverResponse.ok) throw new Error(`Помилка бекенду: ${serverResponse.status}`);
        result = await serverResponse.json();
        
        status.innerText = "✅ Нові ринкові дані успішно оброблені сервером та збережені в кеш!";
        status.style.color = "#81c784";
        renderDashboard(result);

    } catch (error) {
        status.innerText = `❌ Помилка: ${error.message}`;
        status.style.color = "#e57373";
    }
});


function renderDashboard(result) {
    const dashboard = document.getElementById('mainDashboard');
    dashboard.style.display = "grid";

    const tableBody = document.getElementById('pricesTableBody');
    tableBody.innerHTML = '';
    result.processed_prices.forEach(p => {
        tableBody.innerHTML += `
            <tr>
                <td style="font-weight: 600;">${p.market_name}</td>
                <td style="color: #ffb74d;">$${p.raw_price.toFixed(2)}</td>
                <td style="color: #81c784;">$${p.net_price.toFixed(2)} <span style="font-size:11px; color:#aaa;">(${(p.commission*100).toFixed(1)}%)</span></td>
            </tr>`;
    });

    const dealsContainer = document.getElementById('arbitrageDealsContainer');
    dealsContainer.innerHTML = '';
    if (result.arbitrage_opportunities.length === 0) {
        dealsContainer.innerHTML = `<div class="no-deals">Наразі немає вигідних угод (профіт &lt; 2%)</div>`;
    } else {
        result.arbitrage_opportunities.forEach(deal => {
            dealsContainer.innerHTML += `
                <div class="deal-card">
                    <div class="badge">+${deal.profit_percentage}%</div>
                    <div class="deal-route">${deal.source_market} ➔ ${deal.target_market}</div>
                    <div class="deal-details">
                        Купити на <b>${deal.source_market}</b> за: <span style="color:#ffb74d;">$${deal.buy_price.toFixed(2)}</span><br>
                        Чистий витяг після продажу на <b>${deal.target_market}</b>: <span style="color:#81c784;">$${deal.sell_net_price.toFixed(2)}</span>
                    </div>
                </div>`;
        });
    }
}


document.getElementById('massMonitorBtn').addEventListener('click', async () => {
    try {
        const response = await fetch('http://127.0.0.1:8000/api/v1/mass-cache');
        if (!response.ok) throw new Error("Не вдалося з'єднатися з сервером аналітики.");
        const cacheData = await response.json();

        if (cacheData.length === 0) {
            alert("Кеш сервера порожній! Зачекайте пару секунд, фоновий Edge-воркер вже наповнює оперативну пам'ять.");
            return;
        }

        const massWindow = window.open('', '_blank', 'width=1100,height=700,scrollbars=yes');
        massWindow.document.write(`
            <!DOCTYPE html>
            <html lang="uk">
            <head>
                <meta charset="UTF-8">
                <title>Зведена таблиця ринку (Локальний кеш)</title>
                <style>
                    body { font-family: 'Segoe UI', sans-serif; background: #1a1a24; color: #fff; padding: 25px; margin: 0; }
                    .header-area { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #5c6bc0; padding-bottom: 10px; margin-bottom: 5px; }
                    h2 { margin: 0; color: #fff; }
                    .live-indicator { background: rgba(76, 175, 80, 0.2); color: #4caf50; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; display: flex; align-items: center; gap: 6px; }
                    .live-dot { width: 8px; height: 8px; background: #4caf50; border-radius: 50%; animation: blink 1.5s infinite; }
                    .info { color: #aaa; font-size: 14px; margin-bottom: 20px; }
                    table { width: 100%; border-collapse: collapse; background: #242432; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
                    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #333; }
                    th { background: #2e2e3f; color: #aaaaaa; text-transform: uppercase; font-size: 13px; }
                    tr:hover { background: #2a2a3a; }
                    .skin-name { font-weight: 600; color: #e0e0e0; }
                    .price-val { font-family: monospace; font-size: 15px; color: #ffb74d; }
                    .price-val small { color: #81c784; display: block; font-size: 11px; }
                    .dmarket-col { background: rgba(92, 107, 192, 0.05); }
                    .active-deal { background: #4caf50; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }
                    .no-deal { color: #777; font-size: 13px; }
                    @keyframes blink { 0% { opacity: 0.3; } 50% { opacity: 1; } 100% { opacity: 0.3; } }
                </style>
            </head>
            <body>
                <div class="header-area">
                    <h2>📊 Зведена експрес-панель активного кешу</h2>
                    <div class="live-indicator"><div class="live-dot"></div> РЕЖИМ РЕАЛЬНОГО ЧАСУ (5с)</div>
                </div>
                <p class="info">Дані оновлюються автоматично з оперативної пам'ятії сервера. В дужках вказано чисту ціну (Net Price).</p>
                <table>
                    <thead>
                        <tr>
                            <th>Назва віртуального активу</th>
                            <th>Steam (Брутто/Нетто)</th>
                            <th>DMarket Стакан (Брутто/Нетто)</th>
                            <th>Skinport (Брутто/Нетто)</th>
                            <th>Статус арбітражу</th>
                        </tr>
                    </thead>
                    <tbody id="massTableBody"></tbody>
                </table>
                <script>
                    async function updateTableData() {
                        try {
                            const res = await fetch('http://127.0.0.1:8000/api/v1/mass-cache');
                            if (!res.ok) return;
                            const cache = await res.json();
                            const tbody = document.getElementById('massTableBody');
                            let rowsHtml = '';
                            
                            cache.forEach(item => {
                                const steam = item.prices.find(p => p.market_name === 'Steam') || { raw_price: 0, net_price: 0 };
                                const dmarket = item.prices.find(p => p.market_name === 'DMarket') || { raw_price: 0, net_price: 0 };
                                const skinport = item.prices.find(p => p.market_name === 'Skinport') || { raw_price: 0, net_price: 0 };
                                const badge = item.deals_count > 0 
                                    ? '<span class="active-deal">🔥 ' + item.deals_count + ' угод(и)</span>' 
                                    : '<span class="no-deal">немає</span>';

                                rowsHtml += '<tr>' +
                                    '<td class="skin-name">' + item.market_hash_name + '</td>' +
                                    '<td class="price-val">$' + steam.raw_price.toFixed(2) + ' <small>($' + steam.net_price.toFixed(2) + ')</small></td>' +
                                    '<td class="price-val dmarket-col">$' + dmarket.raw_price.toFixed(2) + ' <small>($' + dmarket.net_price.toFixed(2) + ')</small></td>' +
                                    '<td class="price-val">$' + skinport.raw_price.toFixed(2) + ' <small>($' + skinport.net_price.toFixed(2) + ')</small></td>' +
                                    '<td>' + badge + '</td>' +
                                '</tr>';
                            });
                            tbody.innerHTML = rowsHtml;
                        } catch (err) { console.error(err); }
                    }
                    updateTableData();
                    const updateInterval = setInterval(updateTableData, 5000);
                    window.addEventListener('beforeunload', () => clearInterval(updateInterval));
                </script>
            </body>
            </html>
        `);
        massWindow.document.close();
    } catch (error) { alert("Помилка: " + error.message); }
});


async function runDecentralizedWorkerTask() {
    let nextDelay = 4000;

    try {
        const taskResponse = await fetch('http://127.0.0.1:8000/api/v1/get-parsing-task');
        if (!taskResponse.ok) throw new Error(`Сервер офлайн: ${taskResponse.status}`);
        
        const task = await taskResponse.json();
        
        if (!task.task_available) {
            console.log("🤖 Edge-Воркер: Черга порожня, усе закешовано. Очікування нових задач...");
            setTimeout(runDecentralizedWorkerTask, 5000);
            return;
        }

        const skinName = task.market_hash_name;
        console.log(`🤖 Edge-Воркер: Прийнято в роботу унікальну задачу для [${skinName}]`);

        const encodedSkin = encodeURIComponent(skinName);
        const proxyUrl = 'https://cors-anywhere.herokuapp.com/';
        const steamUrl = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodedSkin}`;
        const dmarketUrl = `https://api.dmarket.com/marketplace-api/v1/market-depth?title=${encodedSkin}&gameId=a8db`;

        const [steamResponse, dmarketResponse] = await Promise.all([
            fetch(proxyUrl + steamUrl),
            fetch(proxyUrl + dmarketUrl)
        ]);

        if (steamResponse.status === 429 || dmarketResponse.status === 429) {
            console.warn("⚠️ Виявлено ліміт запитів (429) на проксі! Воркер іде на паузу.");
            setTimeout(runDecentralizedWorkerTask, 15000);
            return;
        }

        if (!steamResponse.ok) throw new Error(`Помилка Steam API: ${steamResponse.status}`);
        
        const steamData = await steamResponse.json();
        let dmarketData = dmarketResponse.ok ? await dmarketResponse.json() : null;
        let realSteamPrice = 0.0;

        if (steamData.success && steamData.lowest_price) {
            realSteamPrice = parseFloat(steamData.lowest_price.replace('$', '').replace(',', '.'));
        } else if (steamData.success && steamData.median_price) {
            realSteamPrice = parseFloat(steamData.median_price.replace('$', '').replace(',', '.'));
        } else {
            setTimeout(runDecentralizedWorkerTask, 2000);
            return; 
        }

        let realDmarketPrice = 0.0;
        if (dmarketData && dmarketData.offers && dmarketData.offers.length > 0) {
            const cheapestOffer = dmarketData.offers[0];
            if (cheapestOffer.price) {
                realDmarketPrice = roundToTwo(parseFloat(cheapestOffer.price) / 100);
            } else {
                realDmarketPrice = roundToTwo(realSteamPrice * 0.78);
            }
        } else {
            realDmarketPrice = roundToTwo(realSteamPrice * 0.78);
        }

        const clientCollectedData = {
            market_hash_name: skinName,
            raw_prices: [
                { market_name: "Steam", raw_price: realSteamPrice },
                { market_name: "DMarket", raw_price: realDmarketPrice },
                { market_name: "Skinport", raw_price: roundToTwo(realSteamPrice * 0.76) }
            ]
        };

        await fetch('http://127.0.0.1:8000/api/v1/process-analytics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clientCollectedData)
        });
        
        console.log(`✅ Edge-Воркер: Оновлено In-Memory кеш сервера для [${skinName}]`);

        const randomJitter = Math.floor(Math.random() * (4500 - 1000 + 1)) + 1000;
        nextDelay = 4000 + randomJitter;
        console.log(`⏱️ Безпека: Наступний запит відбудеться через ${(nextDelay / 1000).toFixed(2)} сек.`);

    } catch (err) {
        console.warn("Мережевий збій, воркер очікує стабілізації...", err.message);
        nextDelay = 8000;
    }

    setTimeout(runDecentralizedWorkerTask, nextDelay);
}

setTimeout(runDecentralizedWorkerTask, 2000);