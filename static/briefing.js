(function() {
    const content = localStorage.getItem('uavchum_briefing_content');
    if (content) {
        document.body.innerHTML = content;
        
        // Re-attach print button listener to avoid inline handlers (CSP)
        const btn = document.querySelector('.print-btn');
        if (btn) {
            btn.addEventListener('click', () => window.print());
        }

        // Auto-print
        setTimeout(() => window.print(), 1000);
    } else {
        document.body.innerHTML = '<p>No briefing data found. Please try generating it again.</p>';
    }
})();
