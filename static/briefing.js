(function() {
    const STORAGE_KEY = 'uavchum_briefing_content';

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function appendTextLine(parent, label, value) {
        const line = el('div');
        if (label) {
            const strong = el('b', '', label);
            line.append(strong, document.createTextNode(value));
        } else {
            line.textContent = value;
        }
        parent.appendChild(line);
    }

    function makeCell(tag, text, className) {
        return el(tag, className || '', text);
    }

    function renderTable(headers, rows, cellClassNames) {
        const table = el('table');
        const thead = el('thead');
        const headRow = el('tr');
        headers.forEach((header, index) => {
            const th = makeCell('th', header);
            if (cellClassNames && cellClassNames[index]) th.className = cellClassNames[index];
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);

        const tbody = el('tbody');
        rows.forEach(row => {
            const tr = el('tr', row.className || '');
            row.cells.forEach((cell, index) => {
                const td = makeCell('td', cell.text, cell.className || (cellClassNames && cellClassNames[index]) || '');
                if (cell.bold) {
                    const strong = el('span');
                    strong.style.fontWeight = 'bold';
                    strong.textContent = cell.text;
                    td.replaceChildren(strong);
                }
                if (cell.style) td.setAttribute('style', cell.style);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.append(thead, tbody);
        return table;
    }

    function renderBriefing(payload) {
        document.body.replaceChildren();

        const page = el('div', 'page');
        const printBtn = el('button', 'print-btn', 'Print Briefing');
        printBtn.type = 'button';
        printBtn.addEventListener('click', () => window.print());
        page.appendChild(printBtn);

        const header = el('div', 'header');
        const branding = el('div');
        branding.append(el('div', 'brand', 'UAVChum'), el('div', 'brand-sub', 'Preflight Briefing'));

        const meta = el('div', 'meta');
        appendTextLine(meta, '', payload.generatedAt || 'Unknown');
        appendTextLine(meta, 'LOCATION: ', payload.location || 'Unknown Location');
        appendTextLine(meta, 'CLASS: ', payload.droneClass || 'Unknown');
        header.append(branding, meta);
        page.appendChild(header);

        const verdictBox = el('div', 'verdict-box', payload.verdict || 'Unavailable');
        verdictBox.appendChild(el('div', 'verdict-sub', payload.summary || ''));
        page.appendChild(verdictBox);

        page.append(
            el('div', 'sec-head', 'Current Telemetry'),
            renderTable(
                ['Parameter', 'Value'],
                (payload.currentTelemetry || []).map(row => ({
                    cells: [{ text: row.label || '' }, { text: row.value || '' }]
                }))
            )
        );

        page.append(
            el('div', 'sec-head', 'System Assessment'),
            renderTable(
                ['Parameter', 'Value', 'Status Note'],
                (payload.systemAssessment || []).map(row => ({
                    cells: [{ text: row.name || '' }, { text: row.value || '' }, { text: row.note || '' }]
                }))
            )
        );

        const checklistRows = (payload.checklist || []).length
            ? payload.checklist.map(item => ({
                cells: [
                    { text: item.checked ? '✓' : '', style: 'width:32px; text-align:center; font-weight:bold;' },
                    { text: item.text || '' }
                ]
            }))
            : [{ cells: [{ text: '', style: 'width:32px; text-align:center; font-weight:bold;' }, { text: '—' }] }];
        page.append(
            el('div', 'sec-head', 'Pre-Flight Checklist'),
            renderTable(['OK', 'Item'], checklistRows)
        );

        page.append(
            el('div', 'sec-head', '7-Day Forecast Horizon'),
            renderTable(
                ['Day', 'Sky', 'Temp', 'Wind (Max)', 'Precip', 'Verdict'],
                (payload.forecast || []).map(row => ({
                    className: 'forecast-row',
                    cells: [
                        { text: row.day || '', className: 'fc-day' },
                        { text: row.desc || '', className: 'fc-desc' },
                        { text: row.temp || '', className: 'fc-temp' },
                        { text: row.wind || '', className: 'fc-wind' },
                        { text: row.precip || '', className: 'fc-precip' },
                        { text: row.verdict || '', bold: true }
                    ]
                }))
            )
        );

        const footer = el('div', 'footer');
        footer.append(
            el('span', '', 'UAVChum Intelligence // uavchum.hehaw.net'),
            el('span', '', `Local Time: ${payload.timezone || 'Unknown'}`)
        );
        page.appendChild(footer);

        document.body.appendChild(page);
        setTimeout(() => window.print(), 1000);
    }

    function renderFallback(message) {
        document.body.replaceChildren(el('p', '', message));
    }

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
        renderFallback('No briefing data found. Please try generating it again.');
        return;
    }

    try {
        const payload = JSON.parse(raw);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Invalid payload shape');
        }
        renderBriefing(payload);
    } catch (error) {
        console.warn('Unable to restore briefing payload:', error);
        renderFallback('Stored briefing data is outdated. Please generate the briefing again.');
    }
})();
