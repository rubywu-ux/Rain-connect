/* =========================================================
   Ruby Wu — interactions
   Dependency-free: reveals, parallax, nav state, menu, accordion
   ========================================================= */
(function () {
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---- Nav: frosted state on scroll ---- */
  var nav = document.querySelector(".nav");
  function onScrollNav() {
    if (!nav) return;
    if (window.scrollY > 40) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  }
  onScrollNav();
  window.addEventListener("scroll", onScrollNav, { passive: true });

  /* ---- Mobile menu ---- */
  var toggle = document.querySelector(".nav__toggle");
  var menu = document.getElementById("site-menu");
  if (toggle && menu) {
    var label = toggle.querySelector("[data-label]");
    var setMenu = function (open) {
      document.body.classList.toggle("menu-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      menu.setAttribute("aria-hidden", open ? "false" : "true");
      if (label) label.textContent = open ? "Close" : "Menu";
    };
    toggle.addEventListener("click", function () {
      setMenu(!document.body.classList.contains("menu-open"));
    });
    menu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { setMenu(false); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("menu-open")) setMenu(false);
    });
  }

  /* ---- Reveal on scroll ---- */
  var reveal = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveal.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveal.forEach(function (el) { io.observe(el); });
  }

  /* ---- Lightweight parallax on [data-parallax] media ---- */
  var parallax = Array.prototype.slice.call(document.querySelectorAll("[data-parallax] img"));
  if (!reduceMotion && parallax.length) {
    var ticking = false;
    function updateParallax() {
      var vh = window.innerHeight;
      parallax.forEach(function (img) {
        var rect = img.parentElement.getBoundingClientRect();
        if (rect.bottom < -200 || rect.top > vh + 200) return;
        var progress = (rect.top + rect.height / 2 - vh / 2) / vh; // -1..1
        var shift = Math.max(-40, Math.min(40, progress * -36));
        img.style.transform = "scale(1.12) translateY(" + shift.toFixed(1) + "px)";
      });
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { window.requestAnimationFrame(updateParallax); ticking = true; }
    }, { passive: true });
    window.addEventListener("resize", updateParallax, { passive: true });
    updateParallax();
  }

  /* ---- Home feed: blur-to-focus + autoplay in view ---- */
  var feedMedia = Array.prototype.slice.call(document.querySelectorAll(".feed__media"));
  if (feedMedia.length) {
    if (!reduceMotion) {
      var feedTicking = false;
      var focusBlur = function () {
        var vh = window.innerHeight, vc = vh / 2;
        feedMedia.forEach(function (m) {
          var r = m.parentElement.getBoundingClientRect();
          if (r.bottom < -120 || r.top > vh + 120) return;
          var center = r.top + r.height / 2;
          var dist = Math.abs(center - vc) / vh;          // 0 = centered
          var blur = Math.min(16, Math.max(0, (dist - 0.12) * 26));
          m.style.filter = "blur(" + blur.toFixed(1) + "px)";
        });
        feedTicking = false;
      };
      window.addEventListener("scroll", function () {
        if (!feedTicking) { window.requestAnimationFrame(focusBlur); feedTicking = true; }
      }, { passive: true });
      window.addEventListener("resize", focusBlur, { passive: true });
      window.addEventListener("load", focusBlur);
      focusBlur();
    }
    var feedVideos = feedMedia.filter(function (m) { return m.tagName === "VIDEO"; });
    if (feedVideos.length && "IntersectionObserver" in window) {
      var feedVio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target;
          if (e.isIntersecting) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
          else { v.pause(); }
        });
      }, { threshold: 0.4 });
      feedVideos.forEach(function (v) { feedVio.observe(v); });
    }
  }

  /* ---- Accordion (About / Experience) ---- */
  document.querySelectorAll(".acc__head").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var item = btn.closest(".acc__item");
      var panel = item.querySelector(".acc__panel");
      var isOpen = item.classList.contains("open");
      if (isOpen) {
        panel.style.height = panel.scrollHeight + "px";
        requestAnimationFrame(function () { panel.style.height = "0px"; });
        item.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
      } else {
        item.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
        panel.style.height = panel.scrollHeight + "px";
        panel.addEventListener("transitionend", function te() {
          if (item.classList.contains("open")) panel.style.height = "auto";
          panel.removeEventListener("transitionend", te);
        });
      }
    });
  });

  /* ---- Play-on-hover video previews ---- */
  if (!reduceMotion) {
    document.querySelectorAll(".has-video").forEach(function (media) {
      var video = media.querySelector(".media__video");
      if (!video) return;
      var card = media.closest("a") || media;
      card.addEventListener("mouseenter", function () {
        media.classList.add("is-playing");
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      });
      card.addEventListener("mouseleave", function () {
        media.classList.remove("is-playing");
        video.pause();
      });
    });
  }

  /* ---- Hero showcase: brief video motion, then transition ---- */
  var showcase = document.querySelector("[data-showcase]");
  if (showcase && !reduceMotion) {
    var slots = showcase.querySelectorAll(".hero__thumb-slot");
    if (slots.length >= 2) {
      var works = [
        { src: "assets/home/cutouts/yubai-motion.webp", cls: "is-cut" },   // moving, transparent
        { src: "assets/home/cutouts/arca-motion.webp",  cls: "is-cut" },   // moving, transparent
        { src: "assets/home/cutouts/ios.png",           cls: "is-cut" },   // dark-frame phone cutout
        { src: "assets/home/cards/discord.png",         cls: "is-photo" }, // faded photo card
        { src: "assets/home/cards/nomtopia.png",        cls: "is-photo" }, // faded photo card
        { src: "assets/home/cards/kenya.png",           cls: "is-photo" }  // faded poster card
      ];
      works.forEach(function (w) { var i = new Image(); i.src = w.poster || w.src; });

      var sIdx = 0, sActive = 0;

      var build = function (w) {
        var el;
        if (w.type === "video") {
          el = document.createElement("video");
          el.muted = true; el.loop = true; el.playsInline = true;
          el.setAttribute("playsinline", ""); el.setAttribute("muted", "");
          el.preload = "auto";
          if (w.poster) el.poster = w.poster;
          el.src = w.src;
        } else {
          el = document.createElement("img");
          el.src = w.src; el.alt = "";
        }
        return el;
      };

      var present = function (w) {
        var incoming = slots[1 - sActive];
        var outgoing = slots[sActive];
        incoming.innerHTML = "";
        incoming.classList.remove("is-cut", "is-photo");
        incoming.classList.add(w.cls);
        var media = build(w);
        incoming.appendChild(media);
        var reveal = function () {
          incoming.classList.add("is-active");
          outgoing.classList.remove("is-active");
          setTimeout(function () {
            var pv = outgoing.querySelector("video");
            if (pv) pv.pause();
          }, 800);
          sActive = 1 - sActive;
          if (w.type === "video") { var p = media.play(); if (p && p.catch) p.catch(function () {}); }
        };
        if (w.type === "video") {
          var done = false;
          var go = function () { if (done) return; done = true; reveal(); };
          media.addEventListener("loadeddata", go, { once: true });
          setTimeout(go, 700);
        } else if (media.complete && media.naturalWidth) {
          reveal();
        } else {
          media.addEventListener("load", reveal, { once: true });
        }
      };

      present(works[0]);
      setInterval(function () {
        if (document.hidden) return;
        sIdx = (sIdx + 1) % works.length;
        present(works[sIdx]);
      }, 2600);
    }
  }

  /* ---- Footer year ---- */
  var y = document.querySelector("[data-year]");
  if (y) y.textContent = new Date().getFullYear();
})();
