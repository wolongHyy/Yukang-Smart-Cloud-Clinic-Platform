(() => {
    "use strict";

    const root = document.documentElement;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const hero = document.getElementById("clinicHero");
    const brand = document.querySelector(".brand");
    const heroDate = document.getElementById("clinicHeroDate");

    const date = new Date();
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    if (heroDate) {
        heroDate.textContent = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} · 今日工作台`;
    }

    let parallaxFrame = 0;
    let pointerX = 0;
    let pointerY = 0;

    function paintBackgroundParallax() {
        parallaxFrame = 0;
        if (reduceMotion.matches || !finePointer.matches) return;
        root.style.setProperty("--yk-bg-x", `${(pointerX * -9).toFixed(2)}px`);
        root.style.setProperty("--yk-bg-y", `${(pointerY * -6).toFixed(2)}px`);
    }

    document.addEventListener("pointermove", (event) => {
        pointerX = event.clientX / Math.max(window.innerWidth, 1) - 0.5;
        pointerY = event.clientY / Math.max(window.innerHeight, 1) - 0.5;
        if (!parallaxFrame) parallaxFrame = requestAnimationFrame(paintBackgroundParallax);
    }, { passive: true });

    document.addEventListener("pointerleave", () => {
        root.style.setProperty("--yk-bg-x", "0px");
        root.style.setProperty("--yk-bg-y", "0px");
    });

    if (hero && finePointer.matches && !reduceMotion.matches) {
        hero.addEventListener("pointermove", (event) => {
            const rect = hero.getBoundingClientRect();
            const x = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
            const y = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
            hero.style.setProperty("--hero-rx", (-y * 7).toFixed(2));
            hero.style.setProperty("--hero-ry", (x * 9).toFixed(2));
        }, { passive: true });

        hero.addEventListener("pointerleave", () => {
            hero.style.setProperty("--hero-rx", "0");
            hero.style.setProperty("--hero-ry", "0");
        });
    }

    const tiltCards = document.querySelectorAll(".quick-action, .kpi-card.clickable, .rev-card, .chart-card");
    if (finePointer.matches && !reduceMotion.matches) {
        tiltCards.forEach((card) => {
            card.addEventListener("pointermove", (event) => {
                const rect = card.getBoundingClientRect();
                const nx = Math.min(1, Math.max(-1, ((event.clientX - rect.left) / rect.width - 0.5) * 2));
                const ny = Math.min(1, Math.max(-1, ((event.clientY - rect.top) / rect.height - 0.5) * 2));
                card.style.setProperty("--rx", `${(-ny * 3.2).toFixed(2)}deg`);
                card.style.setProperty("--ry", `${(nx * 3.8).toFixed(2)}deg`);
                card.style.setProperty("--mx", `${((event.clientX - rect.left) / rect.width * 100).toFixed(1)}%`);
                card.style.setProperty("--my", `${((event.clientY - rect.top) / rect.height * 100).toFixed(1)}%`);
            }, { passive: true });

            card.addEventListener("pointerleave", () => {
                card.style.setProperty("--rx", "0deg");
                card.style.setProperty("--ry", "0deg");
                card.style.setProperty("--lift", "0px");
            });
        });
    }

    function enableKeyboardActivation(element) {
        if (!element || element.dataset.ykKeyboard === "true") return;
        element.dataset.ykKeyboard = "true";
        if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "0");
        if (!element.hasAttribute("role")) element.setAttribute("role", "button");
        element.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                element.click();
            }
        });
    }

    document.querySelectorAll(".quick-action, .kpi-card.clickable").forEach(enableKeyboardActivation);

    if (brand) {
        brand.setAttribute("role", "button");
        brand.setAttribute("tabindex", "0");
        brand.setAttribute("aria-label", "返回愈康工作台首页");
        const goHome = () => {
            if (typeof window.gotoPage === "function") window.gotoPage("page-home");
        };
        brand.addEventListener("click", goHome);
        brand.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                goHome();
            }
        });
    }

    const nav = document.getElementById("mainNav");
    if (nav) {
        const syncCurrentNav = () => {
            nav.querySelectorAll("[data-target]").forEach((item) => {
                if (item.classList.contains("active")) item.setAttribute("aria-current", "page");
                else item.removeAttribute("aria-current");
            });
        };
        syncCurrentNav();
        new MutationObserver(syncCurrentNav).observe(nav, { subtree: true, attributes: true, attributeFilter: ["class"] });
    }
})();
