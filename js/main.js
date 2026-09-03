const menuButton = document.querySelector(".mobile-menu-button");
const mainNav = document.querySelector(".main-nav");

if (menuButton && mainNav) {
    menuButton.addEventListener("click", () => {
        const isOpen = mainNav.classList.toggle("open");

        menuButton.setAttribute("aria-expanded", isOpen);
        document.body.classList.toggle("menu-open", isOpen);
    });

    mainNav.querySelectorAll('a[href^="#"]').forEach((link) => {
        link.addEventListener("click", () => {
            mainNav.classList.remove("open");
            menuButton.setAttribute("aria-expanded", "false");
            document.body.classList.remove("menu-open");
        });
    });
}