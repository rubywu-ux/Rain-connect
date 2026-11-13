/* =========================================================
   Ruby Wu — v2 interactions
   Progress rail, compact progress bar, cursor pill, tabs,
   flip cards, galleries, lightbox, and per-project demos.
   ========================================================= */
(function () {
  "use strict";
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };

  /* ---- Progress rail + floating progress bar ---- */
  var allSections = $$("[data-section]");
  var sections = [], labels = [];
  allSections.forEach(function (s) { // consecutive sections sharing data-group collapse into one rail item
    var g = s.getAttribute("data-group") || s.getAttribute("data-section");
    if (labels[labels.length - 1] !== g) { sections.push(s); labels.push(g); }
  });
  var lastReal = allSections[allSections.length - 1];
  if (sections.length && document.body.getAttribute("data-rail") !== "none") { // data-rail="none" turns it off (home page)
    var backHref = document.body.getAttribute("data-back");
    var backLabel = document.body.getAttribute("data-back-label") || "Back";
    var railTitle = document.body.getAttribute("data-rail-title");

    var rail = document.createElement("aside");
    rail.className = "rail";
    rail.setAttribute("aria-label", "Page progress");
    var railHTML = "";
    if (backHref) railHTML += '<a class="rail__back" href="' + backHref + '">← ' + backLabel + "</a>";
    else if (railTitle) railHTML += '<p class="rail__back">' + railTitle + "</p>";
    railHTML += '<ol class="rail__list">';
    sections.forEach(function (s, i) {
      railHTML += '<li><a href="#' + s.id + '"><span class="rail__bar"><i></i></span><span>' + labels[i] + "</span></a></li>";
    });
    railHTML += '</ol><p class="rail__total"><span data-pct>0</span>% read</p>';
    rail.innerHTML = railHTML;
    document.body.appendChild(rail);

    var mobar = document.createElement("div");
    mobar.className = "mobar";
    var sheet = '<div class="mobar__sheet" role="menu">';
    sections.forEach(function (s, i) {
      sheet += '<a role="menuitem" href="#' + s.id + '"><span>' + labels[i] + "</span><span>" + String(i + 1).padStart(2, "0") + "</span></a>";
    });
    if (backHref) sheet += '<a role="menuitem" href="' + backHref + '"><span>← ' + backLabel + "</span><span></span></a>";
    sheet += "</div>";
    mobar.innerHTML = sheet + '<button class="mobar__btn" aria-expanded="false" aria-label="Jump to section"><span class="mobar__now"></span><span class="mobar__count"></span></button>';
    document.body.appendChild(mobar);

    var railLinks = $$(".rail__list a", rail);
    var sheetLinks = $$(".mobar__sheet a", mobar).slice(0, sections.length);
    var mobarBtn = $(".mobar__btn", mobar);
    var nowEl = $(".mobar__now", mobar), countEl = $(".mobar__count", mobar), pctEl = $("[data-pct]", rail);
    var showAfter = document.body.getAttribute("data-rail") === "after-hero";

    mobarBtn.addEventListener("click", function () {
      var open = !mobar.classList.contains("is-open");
      mobar.classList.toggle("is-open", open);
      mobarBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("a", mobar).forEach(function (a) { a.addEventListener("click", function () { mobar.classList.remove("is-open"); mobarBtn.setAttribute("aria-expanded", "false"); }); });
    document.addEventListener("click", function (e) { if (!mobar.contains(e.target)) mobar.classList.remove("is-open"); });

    var lastActive = -1, ticking = false;
    var update = function () {
      var vh = window.innerHeight, anchor = vh * 0.35, active = 0;
      var first = sections[0].getBoundingClientRect();
      var last = lastReal.getBoundingClientRect();
      sections.forEach(function (s, i) {
        var r = s.getBoundingClientRect();
        var next = sections[i + 1] ? sections[i + 1].getBoundingClientRect().top : last.bottom;
        var span = Math.max(1, next - r.top);
        var p = clamp((anchor - r.top) / span, 0, 1);
        railLinks[i].style.setProperty("--p", p.toFixed(3));
        railLinks[i].classList.toggle("is-done", p >= 1);
        if (r.top <= anchor) active = i;
      });
      var total = clamp((anchor - first.top) / Math.max(1, last.bottom - first.top), 0, 1);
      // reaching the page bottom completes the read
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) total = 1;
      pctEl.textContent = Math.round(total * 100);
      mobarBtn.style.setProperty("--total", total.toFixed(3));
      if (active !== lastActive) {
        railLinks.forEach(function (a, i) { a.classList.toggle("is-active", i === active); if (i === active) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
        sheetLinks.forEach(function (a, i) { a.classList.toggle("is-active", i === active); });
        nowEl.textContent = labels[active];
        countEl.textContent = String(active + 1).padStart(2, "0") + " / " + String(sections.length).padStart(2, "0");
        lastActive = active;
      }
      var visible = showAfter ? (first.top < vh * 0.6 && last.bottom > vh * 0.3) : last.bottom > vh * 0.3;
      var heroBox = document.querySelector(".s-hero");
      if (heroBox && heroBox.getBoundingClientRect().bottom > vh * 0.45) visible = false; // keep the hero clean
      rail.classList.toggle("is-on", visible);
      // tint the rail, nav and progress pill to match dark or lavender sections underneath
      var themeAt = function (y) {
        var t = "";
        $$(".s-sec--dark, .s-sec--lav, .s-sec--hmw").forEach(function (d) { var b = d.getBoundingClientRect(); if (b.top < y && b.bottom > y) t = d.classList.contains("s-sec--lav") ? "lav" : "dark"; });
        return t;
      };
      var mid = themeAt(vh * 0.5), top = themeAt(40), low = themeAt(vh - 40);
      rail.classList.toggle("is-dark", mid === "dark"); rail.classList.toggle("is-lav", mid === "lav");
      mobar.classList.toggle("is-dark", low === "dark"); mobar.classList.toggle("is-lav", low === "lav");
      document.body.classList.toggle("nav-on-dark", top === "dark");
      document.body.classList.toggle("nav-on-lav", top === "lav");
      mobar.classList.toggle("is-on", visible && window.scrollY > 120);
      if (!visible) mobar.classList.remove("is-open");
      ticking = false;
    };
    window.addEventListener("scroll", function () { if (!ticking) { requestAnimationFrame(update); ticking = true; } }, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("load", update);
    update();
  }

  /* ---- In-page jumps (rail, progress pill, "skip to final design") land exactly on target ----
     Lazy images above the target load during the scroll and push it down, so load them first,
     then scroll, then correct once more after things settle. */
  var jumpTo = function (el) {
    var before = function (n) { return n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING; };
    var waits = [];
    $$("img").filter(before).forEach(function (img) {
      if (img.loading === "lazy") img.loading = "eager";
      if (!img.complete) waits.push(new Promise(function (r) { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }));
    });
    $$("video").filter(before).forEach(function (v) {
      if (v.readyState < 1) waits.push(new Promise(function (r) { v.addEventListener("loadedmetadata", r, { once: true }); v.addEventListener("error", r, { once: true }); }));
    });
    var go = function (behavior) { el.scrollIntoView({ behavior: behavior, block: "start" }); };
    var off = function () { return el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0); };
    Promise.race([Promise.all(waits), new Promise(function (r) { setTimeout(r, 900); })]).then(function () {
      go(reduceMotion ? "instant" : "smooth");
      // once the smooth scroll has come to rest, snap onto the target if anything shifted
      var tries = 0;
      var settle = function () {
        if (++tries > 40) return;
        if (performance.now() - lastScrollAt < 180) { setTimeout(settle, 250); return; }
        if (Math.abs(off()) > 6) { go("instant"); setTimeout(settle, 300); }
      };
      setTimeout(settle, 400);
    });
  };
  var lastScrollAt = 0;
  window.addEventListener("scroll", function () { lastScrollAt = performance.now(); }, { passive: true });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute("href").slice(1);
    var el = id && document.getElementById(id);
    if (!el || id === "top") return;
    e.preventDefault();
    jumpTo(el);
    try { history.replaceState(null, "", "#" + id); } catch (err) { /* some embedded viewers block history */ }
  });

  /* ---- Cursor-follow pill ---- */
  var cursorTargets = $$("[data-cursor]");
  if (cursorTargets.length && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    var pill = document.createElement("div");
    pill.className = "cursor-pill";
    document.body.appendChild(pill);
    var px = 0, py = 0, tx = 0, ty = 0, raf = null;
    var loop = function () {
      px += (tx - px) * 0.22; py += (ty - py) * 0.22;
      pill.style.left = px + "px"; pill.style.top = py + "px";
      raf = (Math.abs(tx - px) > 0.3 || Math.abs(ty - py) > 0.3) ? requestAnimationFrame(loop) : null;
    };
    cursorTargets.forEach(function (el) {
      el.addEventListener("mouseenter", function (e) { pill.textContent = el.getAttribute("data-cursor"); px = tx = e.clientX; py = ty = e.clientY; pill.classList.add("is-on"); loop(); });
      el.addEventListener("mousemove", function (e) { tx = e.clientX; ty = e.clientY; if (!raf) raf = requestAnimationFrame(loop); });
      el.addEventListener("mouseleave", function () { pill.classList.remove("is-on"); });
    });
  }

  /* ---- Videos: play only while in view ---- */
  var vids = $$("video[data-autoplay]");
  if (vids.length && "IntersectionObserver" in window) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting && !reduceMotion) { v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        else v.pause();
      });
    }, { threshold: 0.25 });
    vids.forEach(function (v) { vio.observe(v); });
  }

  /* ---- Tabs ---- */
  $$("[data-tabs]").forEach(function (root) {
    var tabs = $$('[role="tab"]', root);
    var select = function (tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !on;
      });
    };
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { select(t); });
      t.addEventListener("keydown", function (e) {
        var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!d) return;
        var n = tabs[(i + d + tabs.length) % tabs.length];
        n.focus(); select(n);
      });
    });
  });

  /* ---- Flip cards ---- */
  $$(".flip").forEach(function (f) {
    f.addEventListener("click", function () {
      var on = f.classList.toggle("is-flipped");
      f.setAttribute("aria-pressed", on ? "true" : "false");
    });
  });

  /* ---- Drag-to-scroll galleries ---- */
  $$(".s-gallery").forEach(function (g) {
    var down = false, sx = 0, sl = 0, moved = false;
    g.addEventListener("pointerdown", function (e) { if (e.pointerType !== "mouse") return; down = true; moved = false; sx = e.clientX; sl = g.scrollLeft; g.classList.add("is-dragging"); });
    window.addEventListener("pointermove", function (e) { if (!down) return; var dx = e.clientX - sx; if (Math.abs(dx) > 4) moved = true; g.scrollLeft = sl - dx; });
    window.addEventListener("pointerup", function () { if (!down) return; down = false; g.classList.remove("is-dragging"); });
    g.addEventListener("click", function (e) { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  });

  /* ---- Lightbox ---- */
  var zoomables = $$(".s-fig--zoom img");
  if (zoomables.length) {
    var lb = document.createElement("div");
    lb.className = "lightbox";
    lb.setAttribute("role", "dialog");
    lb.setAttribute("aria-label", "Image preview");
    lb.innerHTML = "<img alt='' />";
    document.body.appendChild(lb);
    var lbImg = $("img", lb);
    var close = function () { lb.classList.remove("is-on"); };
    zoomables.forEach(function (img) {
      img.addEventListener("click", function () { lbImg.src = img.currentSrc || img.src; lbImg.alt = img.alt; lb.classList.add("is-on"); });
    });
    lb.addEventListener("click", close);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  }

  /* ---- Yubai: Pulse dial quiets the Loom display ---- */
  var dial = $(".pulse__dial");
  if (dial) {
    var loom = $(".loom"), status = $(".pulse__status");
    var value = 0; // 0..1
    var msgs = ["Loom is ambient: messages + home status visible.", "Settling in… notifications softened.", "Reading in progress. Family sees a quiet “Do Not Disturb.”"];
    var render = function () {
      dial.style.setProperty("--a", (value * 270 - 135) + "deg");
      loom.style.setProperty("--q", value.toFixed(2));
      loom.classList.toggle("is-quiet", value > 0.66);
      dial.setAttribute("aria-valuenow", Math.round(value * 100));
      status.textContent = msgs[value > 0.66 ? 2 : value > 0.25 ? 1 : 0];
    };
    var angleFrom = function (e) {
      var r = dial.getBoundingClientRect();
      var a = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI; // 0 = up
      return clamp((a + 135) / 270, 0, 1);
    };
    var dragging = false;
    dial.addEventListener("pointerdown", function (e) { dragging = true; dial.setPointerCapture(e.pointerId); value = angleFrom(e); render(); });
    dial.addEventListener("pointermove", function (e) { if (dragging) { value = angleFrom(e); render(); } });
    dial.addEventListener("pointerup", function () { dragging = false; });
    dial.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") value = clamp(value + 0.1, 0, 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowDown") value = clamp(value - 0.1, 0, 1);
      else return;
      e.preventDefault(); render();
    });
    render();
  }

  /* ---- Arca: privacy state indicator ---- */
  var cam = $(".cam");
  if (cam) {
    var desc = $(".states__desc");
    $$(".states button").forEach(function (b) {
      b.addEventListener("click", function () {
        $$(".states button").forEach(function (o) { o.setAttribute("aria-pressed", o === b ? "true" : "false"); });
        cam.setAttribute("data-state", b.getAttribute("data-state"));
        desc.textContent = b.getAttribute("data-desc");
      });
    });
  }

  /* ---- Discord: swipe-to-catch-up stack ---- */
  var stack = $(".swipe__stack");
  if (stack) {
    var tpl = stack.innerHTML;
    var leftEl = $("[data-left]"), log = $(".swipe__log");
    var counts = { read: 0, keep: 0 };
    var refresh = function () {
      var n = $$(".scard", stack).length;
      leftEl.textContent = n + " Left";
      log.textContent = counts.read + " marked read · " + counts.keep + " kept unread";
      if (!n) {
        var done = document.createElement("div");
        done.className = "swipe__done";
        done.innerHTML = "<div><p>You're all caught up ✦</p><button type='button'>Replay</button></div>";
        stack.appendChild(done);
        $("button", done).addEventListener("click", function () { counts = { read: 0, keep: 0 }; stack.innerHTML = tpl; bind(); refresh(); });
      }
    };
    var fling = function (card, dir) {
      counts[dir > 0 ? "read" : "keep"]++;
      card.style.transform = "translateX(" + (dir * 140) + "%) rotate(" + (dir * 18) + "deg)";
      card.style.opacity = "0";
      setTimeout(function () { card.remove(); refresh(); }, 380);
    };
    var bind = function () {
      $$(".scard", stack).forEach(function (card) {
        var sx = 0, dx = 0, on = false;
        var read = $(".scard__stamp--read", card), keep = $(".scard__stamp--keep", card);
        card.addEventListener("pointerdown", function (e) { if (card !== stack.querySelector(".scard:last-of-type")) return; on = true; sx = e.clientX; dx = 0; card.setPointerCapture(e.pointerId); card.classList.add("is-drag"); });
        card.addEventListener("pointermove", function (e) {
          if (!on) return; dx = e.clientX - sx;
          card.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 18) + "deg)";
          read.style.opacity = clamp(dx / 90, 0, 1); keep.style.opacity = clamp(-dx / 90, 0, 1);
        });
        var end = function () {
          if (!on) return; on = false; card.classList.remove("is-drag");
          if (Math.abs(dx) > 90) fling(card, dx > 0 ? 1 : -1);
          else { card.style.transform = ""; read.style.opacity = 0; keep.style.opacity = 0; }
        };
        card.addEventListener("pointerup", end);
        card.addEventListener("pointercancel", end);
      });
    };
    $$(".swipe__btns button").forEach(function (b) {
      b.addEventListener("click", function () {
        var top = stack.querySelector(".scard:last-of-type");
        if (top) fling(top, b.classList.contains("read") ? 1 : -1);
      });
    });
    bind(); refresh();
  }

  /* ---- iOS: tap the heart to reach the goal ---- */
  var goalBtn = $(".goal__btn");
  if (goalBtn) {
    var taps = 0, need = 5, bar = $(".goal__bar i"), cnt = $(".goal__count"), toast = $(".goal__toast");
    var burst = function (x, y) {
      if (reduceMotion) return;
      var colors = ["#FF2D55", "#FF9F0A", "#30D158", "#5E5CE6", "#64D2FF"];
      for (var i = 0; i < 26; i++) {
        var c = document.createElement("i");
        c.className = "confetti";
        c.style.background = colors[i % colors.length];
        c.style.left = x + "px"; c.style.top = y + "px";
        document.body.appendChild(c);
        var ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 140;
        c.animate([
          { transform: "translate(0,0) rotate(0)", opacity: 1 },
          { transform: "translate(" + Math.cos(ang) * dist + "px," + (Math.sin(ang) * dist + 120) + "px) rotate(" + (Math.random() * 720) + "deg)", opacity: 0 }
        ], { duration: 1100 + Math.random() * 500, easing: "cubic-bezier(.2,.7,.3,1)" }).onfinish = (function (el) { return function () { el.remove(); }; })(c);
      }
    };
    goalBtn.addEventListener("click", function (e) {
      if (navigator.vibrate) navigator.vibrate(taps + 1 >= need ? [30, 40, 60] : 18);
      goalBtn.classList.add("is-pop");
      setTimeout(function () { goalBtn.classList.remove("is-pop"); }, 140);
      if (taps >= need) { taps = 0; toast.classList.remove("is-on"); }
      else taps++;
      bar.style.width = (taps / need * 100) + "%";
      cnt.textContent = taps >= need ? "Goal reached" : (taps * 2000).toLocaleString() + " / 10,000 steps";
      if (taps >= need) {
        toast.classList.add("is-on");
        var r = goalBtn.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2);
      }
    });
  }

  /* ---- Mini prototypes: phone frame that steps through screens ---- */
  $$("[data-proto]").forEach(function (root) {
    var slides = $$(".proto__slide", root);
    var steps = $$(".proto__steps button", root);
    var screen = $(".proto__screen", root);
    var toggle = $("[data-proto-toggle]", root), stateEl = $(".proto__controls .state", root);
    var base = parseInt(root.getAttribute("data-interval"), 10) || 3400;
    var idx = 0, playing = !reduceMotion, inView = false, hovering = false, t0 = 0, hold = base, raf = null;
    // Compact switcher under the phone: ← title → with the description below
    var stepList = $(".proto__steps", root), caption = null, capK, capT, capD, capBar;
    if (stepList) {
      caption = document.createElement("div"); caption.className = "proto__caption";
      var nav = document.createElement("div"); nav.className = "proto__nav";
      var mid = document.createElement("div"); mid.className = "proto__mid"; mid.setAttribute("aria-live", "polite");
      capK = document.createElement("p"); capK.className = "k";
      capT = document.createElement("p"); capT.className = "t";
      capBar = document.createElement("span"); capBar.className = "bar"; capBar.setAttribute("aria-hidden", "true");
      capD = document.createElement("p"); capD.className = "d";
      mid.appendChild(capK); mid.appendChild(capT); mid.appendChild(capBar);
      var pB = $("[data-proto-prev]", root), nB = $("[data-proto-next]", root);
      if (pB) nav.appendChild(pB);
      nav.appendChild(mid);
      if (nB) nav.appendChild(nB);
      caption.appendChild(nav); caption.appendChild(capD);
      stepList.insertAdjacentElement("afterend", caption);
      root.classList.add("proto--compact");
    }

    var holdFor = function (el) {
      if (el.tagName === "VIDEO") return el.duration && isFinite(el.duration) ? Math.min(Math.max(el.duration * 1000, 4000), 12000) : 6000;
      return parseInt(el.getAttribute("data-hold"), 10) || base;
    };
    var show = function (n) {
      var prev = idx;
      idx = (n + slides.length) % slides.length;
      slides.forEach(function (s, i) {
        s.classList.toggle("is-active", i === idx);
        s.classList.toggle("is-prev", i === prev && i !== idx);
        if (s.tagName === "VIDEO") { if (i === idx) { s.currentTime = 0; var p = s.play(); if (p && p.catch) p.catch(function () {}); } else s.pause(); }
      });
      steps.forEach(function (b, i) {
        if (i === idx) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
        b.style.setProperty("--p", i < idx ? 1 : 0);
      });
      if (caption && steps[idx]) {
        var li = steps[idx].parentElement, grp = li.previousElementSibling;
        while (grp && !grp.classList.contains("proto__group")) grp = grp.previousElementSibling;
        var tEl = steps[idx].querySelector("b"), dEl = steps[idx].querySelector(".d");
        var num = function (n) { return (n < 10 ? "0" : "") + n; };
        capK.textContent = num(idx + 1) + " / " + num(slides.length) + (grp ? " · " + grp.textContent.replace(/^Flow \d+ · /, "") : "");
        capBar.style.setProperty("--p", 0);
        capT.textContent = tEl ? tEl.textContent : "";
        capD.textContent = dEl ? dEl.textContent : "";
        caption.classList.remove("is-in"); void caption.offsetWidth; caption.classList.add("is-in");
      }
      var cur = slides[idx];
      hold = holdFor(cur);
      if (cur.classList.contains("is-tall")) {
        cur.style.animation = "none"; void cur.offsetWidth; cur.style.animation = "";
        var shift = Math.max(0, cur.getBoundingClientRect().height - screen.getBoundingClientRect().height);
        cur.style.setProperty("--shift", -shift + "px");
        cur.style.setProperty("--dur-tall", Math.max(1500, hold - 1400) + "ms");
      }
      if (steps[idx] && window.matchMedia("(max-width: 760px)").matches) {
        var list = steps[idx].closest(".proto__steps");
        list.scrollTo({ left: steps[idx].parentElement.offsetLeft - list.offsetLeft, behavior: "smooth" });
      }
      t0 = performance.now();
    };
    var tick = function (now) {
      raf = null;
      if (!(playing && inView && !hovering)) { t0 = now - (steps[idx] ? parseFloat(steps[idx].style.getPropertyValue("--p") || 0) * hold : 0); return; }
      var p = Math.min(1, (now - t0) / hold);
      if (steps[idx]) steps[idx].style.setProperty("--p", p.toFixed(3));
      if (capBar) capBar.style.setProperty("--p", p.toFixed(3));
      if (p >= 1) show(idx + 1);
      raf = requestAnimationFrame(tick);
    };
    var kick = function () { if (!raf && playing && inView && !hovering) { t0 = performance.now() - (parseFloat(steps[idx] && steps[idx].style.getPropertyValue("--p")) || 0) * hold; raf = requestAnimationFrame(tick); } };
    var setPlaying = function (on) {
      playing = on;
      if (toggle) { toggle.textContent = on ? "❚❚" : "▶"; toggle.setAttribute("aria-label", on ? "Pause prototype" : "Play prototype"); }
      if (stateEl) stateEl.textContent = on ? "Auto-playing" : "Paused";
      kick();
    };

    steps.forEach(function (b, i) { b.addEventListener("click", function () { show(i); kick(); }); });
    var prevB = $("[data-proto-prev]", root), nextB = $("[data-proto-next]", root);
    if (prevB) prevB.addEventListener("click", function () { show(idx - 1); kick(); });
    if (nextB) nextB.addEventListener("click", function () { show(idx + 1); kick(); });
    if (toggle) toggle.addEventListener("click", function () { setPlaying(!playing); });
    screen.addEventListener("click", function () { show(idx + 1); kick(); });
    var dev = $(".proto__device", root);
    dev.addEventListener("mouseenter", function () { hovering = true; });
    dev.addEventListener("mouseleave", function () { hovering = false; kick(); });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { inView = e.isIntersecting; kick(); }); }, { threshold: 0.35 }).observe(root);
    } else inView = true;
    slides.forEach(function (s) { if (s.tagName === "VIDEO") s.addEventListener("loadedmetadata", function () { if (slides[idx] === s) hold = holdFor(s); }); });
    show(0); setPlaying(playing);
  });

  /* ---- Arca: "Hey Arca" voice card pops up, then "Calling Kiana" types out (loops while in view) ---- */
  $$("[data-call]").forEach(function (card) {
    var lines = $$("[data-type]", card), timers = [], running = false;
    var clear = function () { timers.forEach(clearTimeout); timers = []; };
    var at = function (ms, fn) { timers.push(setTimeout(fn, ms)); };
    var type = function (el, start, speed) {
      var txt = el.getAttribute("data-type");
      for (var i = 0; i <= txt.length; i++) (function (n) { at(start + n * speed, function () { el.textContent = txt.slice(0, n); }); })(i);
      return start + txt.length * speed;
    };
    var cycle = function () {
      clear();
      lines.forEach(function (l) { l.textContent = ""; });
      card.classList.remove("is-calling");
      var t = type(lines[0], 900, 70);
      at(t + 700, function () { card.classList.add("is-calling"); });
      t = type(lines[1], t + 1000, 85);
      at(t + 3200, cycle);
    };
    if (reduceMotion) { lines.forEach(function (l) { l.textContent = l.getAttribute("data-type"); }); card.classList.add("is-calling"); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting && !running) { running = true; cycle(); }
        else if (!e.isIntersecting && running) { running = false; clear(); }
      });
    }, { threshold: 0.4 }).observe(card.parentElement);
  });

  /* ---- Full-screen case hero: word reveal + scroll fade ---- */
  var hero = $(".s-hero");
  if (hero) {
    var title = $(".s-hero__title", hero);
    if (title) {
      var nodes = Array.prototype.slice.call(title.childNodes);
      title.textContent = "";
      nodes.forEach(function (n) {
        if (n.nodeName === "BR") { title.appendChild(n); return; }
        var parts = n.nodeType === 3 ? n.textContent.split(/(\s+)/) : [n];
        parts.forEach(function (part) {
          if (typeof part === "string") {
            if (!part) return;
            if (/^\s+$/.test(part)) { title.appendChild(document.createTextNode(" ")); return; }
          }
          var w = document.createElement("span"), inner = document.createElement("span");
          w.className = "w";
          if (typeof part === "string") inner.textContent = part; else inner.appendChild(part);
          w.appendChild(inner); title.appendChild(w);
        });
      });
      $$(".w > span", title).forEach(function (sp, i) { sp.style.transitionDelay = (0.25 + i * 0.09) + "s"; });
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { hero.classList.add("is-in"); }); });
    if (!reduceMotion) {
      var hTick = false;
      var heroScroll = function () {
        var r = hero.getBoundingClientRect();
        hero.style.setProperty("--hp", clamp(-r.top / Math.max(1, r.height), 0, 1).toFixed(3));
        hTick = false;
      };
      window.addEventListener("scroll", function () { if (!hTick) { requestAnimationFrame(heroScroll); hTick = true; } }, { passive: true });
      heroScroll();
    }
  }

  /* ---- Apple Health: tap and hold the heart to hear your resting heart rate ----
     It beats only while held; letting go stops it. Beats run on the audio clock at
     exactly 60/56 s apart (no rounding, no timer drift): sound is scheduled ahead on
     the AudioContext and the heart/ECG pulse is fired at the same moments.
     Each beat is a synthesized lub-dub (Web Audio, no sound file) built to feel like a
     vibration: a deep sub (~40 Hz) for headphones and bigger speakers, a low body tone,
     a softly distorted "rumble" layer whose overtones let phone and laptop speakers
     (which can't play deep bass) still sound heavy, and a muffled knock for the hit.
     All through a compressor for punch.
     Phones only allow sound after a completed tap, and pressing down is not one yet,
     so audio is also unlocked by any earlier tap on the page; if the very first hold is
     still silent it runs on the page clock instead, and the release unlocks sound.
     On iPhone it follows the ring/silent switch. */
  var hrBtn = $(".hr__btn");
  if (hrBtn) {
    var BPM = 56, PERIOD = 60 / BPM; // 1.0714… s
    var small = window.matchMedia && matchMedia("(pointer: coarse)").matches; // phones/tablets: tiny speakers
    var ac = null, master = null, bus = null, noise = null;
    var holding = false, useAudio = false, nextAt = 0, n = 0, heard = false, loop = null, pending = [];
    var audio = function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !ac) {
        ac = new AC();
        var comp = ac.createDynamicsCompressor();
        comp.threshold.value = -18; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.002; comp.release.value = 0.12;
        master = ac.createGain(); master.gain.value = small ? 1.9 : 1.6;
        master.connect(comp); comp.connect(ac.destination);
        noise = ac.createBuffer(1, Math.round(ac.sampleRate * 0.05), ac.sampleRate);
        var d = noise.getChannelData(0);
        for (var k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
      }
      if (ac && ac.state !== "running") ac.resume();
      return ac;
    };
    var unlock = function () {
      if (!audio()) return;
      var b = ac.createBufferSource(); b.buffer = ac.createBuffer(1, 1, 22050); b.connect(ac.destination); b.start(0);
    };
    ["pointerup", "touchend", "click", "keydown"].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });
    var curve = null; // soft saturation: adds overtones so small speakers "hear" the bass
    var makeRumble = function (dest) { // shaper -> lowpass -> this hold's bus, so release silences it too
      if (!curve) {
        curve = new Float32Array(1024);
        for (var q = 0; q < curve.length; q++) { var x = q / 511.5 - 1; curve[q] = Math.tanh(x * 4); }
      }
      var sh = ac.createWaveShaper(), lp = ac.createBiquadFilter();
      sh.curve = curve; sh.oversample = "4x";
      lp.type = "lowpass"; lp.frequency.value = small ? 560 : 320; lp.Q.value = 0.7;
      sh.connect(lp); lp.connect(dest);
      return sh;
    };
    var tone = function (at, from, to, vol, len, out) {
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(from, at);
      o.frequency.exponentialRampToValueAtTime(to, at + 0.06);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g); g.connect(out || bus); o.start(at); o.stop(at + len + 0.02);
    };
    var knock = function (at, vol) { // muffled transient, gives the beat its "thump"
      var src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noise; f.type = "lowpass"; f.frequency.value = 120; f.Q.value = 0.8;
      g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      src.connect(f); f.connect(g); g.connect(bus); src.start(at);
    };
    var thump = function (at, hz, vol) {
      tone(at, hz * 1.1, hz * 0.62, vol * 1.1, 0.42);  // deep sub, ~40 Hz with a long rumble tail
      tone(at, hz * 2, hz, vol * 0.75, 0.26);          // body
      tone(at, hz * 1.6, hz * 0.8, vol * 0.95, 0.32, bus.rumble); // saturated rumble for small speakers
      knock(at, vol * 0.9);
      // small speakers can't play deep bass, so add a saturated punch where they do work (~100–160 Hz + overtones):
      // full strength on phones/tablets, a lighter touch on laptops/desktops
      tone(at, hz * 2.8, hz * 1.75, vol * (small ? 1.1 : 0.6), 0.26, bus.rumble);
    };
    var ecg = $(".hr__ecg"), bpmEl = $("[data-bpm]"), note = $(".hr__note");
    var pulse = function () { // visual beat, fired exactly when the lub plays
      if (!holding) return;
      n++;
      hrBtn.classList.remove("is-beat"); ecg.classList.remove("is-beat");
      void hrBtn.offsetWidth;
      hrBtn.classList.add("is-beat"); ecg.classList.add("is-beat");
      bpmEl.textContent = BPM;
      note.textContent = n < 3 ? "Keep holding\u2026 listen to the rhythm." : "Beat " + n + ". That\u2019s 56 BPM, your resting rate today.";
    };
    var now = function () { return useAudio ? ac.currentTime : performance.now() / 1000; };
    var schedule = function () { // look 150 ms ahead and queue every beat that falls inside it
      while (nextAt < now() + 0.15) {
        if (useAudio) {
          thump(nextAt, 58, 1);           // lub
          thump(nextAt + 0.16, 70, 0.65); // dub
          heard = true;
        }
        pending.push(setTimeout(pulse, Math.max(0, (nextAt - now()) * 1000)));
        nextAt += PERIOD;
      }
    };
    var run = function (withAudio) {
      if (!holding || loop) return;
      useAudio = withAudio;
      if (useAudio) { bus = ac.createGain(); bus.connect(master); bus.rumble = makeRumble(bus); }
      nextAt = now() + 0.03;
      schedule(); loop = setInterval(schedule, 25);
    };
    var start = function (e) {
      if (holding) return;
      if (e && e.pointerId != null && hrBtn.setPointerCapture) hrBtn.setPointerCapture(e.pointerId);
      holding = true; n = 0; heard = false;
      hrBtn.classList.add("is-holding"); hrBtn.setAttribute("aria-pressed", "true");
      audio();
      if (ac && ac.state === "running") run(true);
      else if (ac) {
        ac.resume().then(function () { if (ac.state === "running") run(true); }, function () {});
        setTimeout(function () { run(false); }, 160); // phone hasn't allowed sound yet: beat silently
      } else run(false);
    };
    var stop = function () {
      if (!holding) return;
      holding = false;
      clearInterval(loop); loop = null;
      pending.forEach(clearTimeout); pending = [];
      if (bus) { // silence anything already queued, then drop it
        var b = bus; bus = null;
        b.gain.setTargetAtTime(0, ac.currentTime, 0.015);
        setTimeout(function () { b.disconnect(); }, 200);
      }
      hrBtn.classList.remove("is-holding"); hrBtn.setAttribute("aria-pressed", "false");
      note.textContent = !heard && n > 0
        ? "Sound is ready now. Tap and hold the heart again to hear it."
        : n >= 3
          ? "Your resting rate is 56 BPM, and this week it improved into a 48\u201352 range. Hold again to hear it."
          : "Keep holding the heart to hear your resting rhythm.";
    };
    hrBtn.addEventListener("pointerdown", function (e) { e.preventDefault(); start(e); });
    ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (ev) { hrBtn.addEventListener(ev, stop); });
    hrBtn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    // iPhone: stop the long-press preview/callout from taking over the hold
    hrBtn.addEventListener("touchstart", function (e) { e.preventDefault(); }, { passive: false });
    hrBtn.addEventListener("keydown", function (e) { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); start(); } });
    hrBtn.addEventListener("keyup", function (e) { if (e.key === " " || e.key === "Enter") stop(); });
    hrBtn.addEventListener("blur", stop);
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { if (!es[0].isIntersecting) stop(); }).observe(hrBtn);
  }

  /* ---- Discord: interview quotes pop in like chat messages ---- */
  var chatMsgs = $$(".chat__msg");
  if (chatMsgs.length) {
    var say = function (m) {
      m.classList.add("is-in");
      setTimeout(function () { m.classList.add("is-said"); }, reduceMotion ? 0 : 750);
    };
    if (reduceMotion || !("IntersectionObserver" in window)) chatMsgs.forEach(say);
    else {
      var queueT = 0;
      var cio = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (!e.isIntersecting) return;
          cio.unobserve(e.target);
          var now = Date.now(), wait = Math.max(0, queueT - now);
          queueT = now + wait + 500; // stagger messages that arrive together
          setTimeout(function () { say(e.target); }, wait);
        });
      }, { threshold: 0.6, rootMargin: "0px 0px -10% 0px" });
      chatMsgs.forEach(function (m) { cio.observe(m); });
    }
  }

  /* ---- Discord: catch-up card stack, built from the Figma card system ---- */
  var dc = $(".dc");
  if (dc) {
    var dcScreen = dc.parentElement;
    var fit = function () { dc.style.setProperty("--k", (dcScreen.clientWidth / 393).toFixed(4)); };
    if ("ResizeObserver" in window) new ResizeObserver(fit).observe(dcScreen); else window.addEventListener("resize", fit);
    fit();
    var cards = $$(".dc-card", dc), stackEl = $(".dc__stack", dc), leftEl2 = $("[data-dc-left]", dc), undoBtn = $("[data-dc-undo]", dc), doneEl = $(".dc__done", dc), logEl = $(".dc-demo .swipe__log");
    var queue = cards.slice(), history = [], tally = { read: 0, keep: 0 };
    var layout = function () {
      queue.forEach(function (c, i) { c.setAttribute("data-depth", i); c.style.zIndex = 10 - i; c.style.transform = ""; c.style.opacity = ""; $$(".dc-card__swipe", c).forEach(function (o) { o.style.opacity = 0; }); });
      leftEl2.textContent = queue.length + " Left";
      undoBtn.disabled = !history.length;
      doneEl.classList.toggle("is-on", !queue.length);
      logEl.textContent = tally.read + " marked read · " + tally.keep + " kept unread";
    };
    var fling = function (dir) {
      var c = queue.shift(); if (!c) return;
      tally[dir > 0 ? "read" : "keep"]++;
      history.push({ c: c, dir: dir });
      c.style.transform = "translateX(" + (dir * 130) + "%) rotate(" + (dir * 16) + "deg)";
      c.style.opacity = "0";
      $(dir > 0 ? ".dc-card__swipe--read" : ".dc-card__swipe--keep", c).style.opacity = 1;
      c.removeAttribute("data-depth");
      setTimeout(layout, 30);
    };
    undoBtn.addEventListener("click", function () {
      var h = history.pop(); if (!h) return;
      tally[h.dir > 0 ? "read" : "keep"]--;
      queue.unshift(h.c); layout();
    });
    $(".dc__done button", dc).addEventListener("click", function () { queue = cards.slice(); history = []; tally = { read: 0, keep: 0 }; layout(); });
    $$(".dc__btns button", dc).forEach(function (b) { b.addEventListener("click", function () { fling(b.classList.contains("read") ? 1 : -1); }); });
    cards.forEach(function (c) {
      var sx = 0, dx = 0, on = false, k = 1;
      var rd = $(".dc-card__swipe--read", c), kp = $(".dc-card__swipe--keep", c);
      c.addEventListener("pointerdown", function (e) { if (queue[0] !== c) return; on = true; sx = e.clientX; dx = 0; k = parseFloat(dc.style.getPropertyValue("--k")) || 1; c.setPointerCapture(e.pointerId); c.classList.add("is-drag"); });
      c.addEventListener("pointermove", function (e) {
        if (!on) return; dx = (e.clientX - sx) / k;
        c.style.transform = "translateX(" + dx + "px) rotate(" + (dx / 22) + "deg)";
        rd.style.opacity = clamp(dx / 140, 0, 1); kp.style.opacity = clamp(-dx / 140, 0, 1);
      });
      var end = function () {
        if (!on) return; on = false; c.classList.remove("is-drag");
        if (Math.abs(dx) > 110) fling(dx > 0 ? 1 : -1); else layout();
      };
      c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
    });
    layout();
  }

  /* ---- Scroll-driven steps: one big statement at a time ---- */
  $$("[data-scrolly]").forEach(function (root) {
    if (reduceMotion) return;
    var items = $$(".scrolly__item", root), nums = $$(".scrolly__nav li", root), cur = -1, tick = false;
    var update = function () {
      var r = root.getBoundingClientRect(), vh = window.innerHeight;
      var p = clamp(-r.top / Math.max(1, r.height - vh), 0, 0.9999) * items.length;
      var idx = Math.floor(p);
      nums.forEach(function (li, i) { li.style.setProperty("--p", clamp(p - i, 0, 1).toFixed(3)); li.classList.toggle("is-active", i === idx); });
      if (idx !== cur) {
        items.forEach(function (it, i) { it.classList.toggle("is-active", i === idx); it.classList.toggle("is-past", i < idx); });
        cur = idx;
      }
      tick = false;
    };
    window.addEventListener("scroll", function () { if (!tick) { requestAnimationFrame(update); tick = true; } }, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
  });

  /* ---- Quote loop: auto-advances while in view, pauses on hover ---- */
  $$("[data-qloop]").forEach(function (root) {
    var items = $$(".qloop__item", root), btns = $$(".qloop__nav button", root);
    var HOLD = 3600, idx = 0, t0 = performance.now(), inView = false, hover = false, raf = null;
    var show = function (n) {
      var prev = items[idx];
      idx = (n + items.length) % items.length;
      items.forEach(function (it, i) {
        it.classList.toggle("is-active", i === idx);
        it.classList.toggle("is-leaving", it === prev && i !== idx);
        it.setAttribute("aria-hidden", i === idx ? "false" : "true");
      });
      btns.forEach(function (b, i) { if (i === idx) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); b.style.setProperty("--p", 0); });
      t0 = performance.now();
    };
    var loop = function (now) {
      raf = null;
      if (!inView || hover || reduceMotion) return;
      var p = Math.min(1, (now - t0) / HOLD);
      btns[idx].style.setProperty("--p", p.toFixed(3));
      if (p >= 1) show(idx + 1);
      raf = requestAnimationFrame(loop);
    };
    var kick = function () { if (!raf && inView && !hover && !reduceMotion) { t0 = performance.now() - (parseFloat(btns[idx].style.getPropertyValue("--p")) || 0) * HOLD; raf = requestAnimationFrame(loop); } };
    btns.forEach(function (b, i) { b.addEventListener("click", function () { show(i); kick(); }); });
    root.addEventListener("mouseenter", function () { hover = true; });
    root.addEventListener("mouseleave", function () { hover = false; kick(); });
    if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { es.forEach(function (e) { inView = e.isIntersecting; kick(); }); }, { threshold: 0.4 }).observe(root);
    else { inView = true; kick(); }
  });

  /* ---- How might we: words light up one by one as you scroll ---- */
  $$("[data-hmw]").forEach(function (root) {
    var stmt = $(".s-hmw", root), words = [];
    var wrap = function (node, isEm) {
      Array.prototype.slice.call(node.childNodes).forEach(function (n) {
        if (n.nodeType === 3) {
          var frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var w = document.createElement("span");
            w.className = "hw" + (isEm ? " is-em" : ""); w.textContent = part;
            frag.appendChild(w); words.push(w);
          });
          n.parentNode.replaceChild(frag, n);
        } else if (n.nodeType === 1) wrap(n, isEm || n.tagName === "EM");
      });
    };
    wrap(stmt, false);
    if (reduceMotion) { words.forEach(function (w) { w.classList.add("is-lit"); }); return; }
    var tick = false;
    var update = function () {
      var r = root.getBoundingClientRect(), vh = window.innerHeight;
      var p = clamp((vh * 0.35 - r.top) / Math.max(1, r.height - vh * 0.9), 0, 1);
      var lit = Math.round(p * words.length * 1.1);
      words.forEach(function (w, i) { w.classList.toggle("is-lit", i < lit); });
      tick = false;
    };
    window.addEventListener("scroll", function () { if (!tick) { requestAnimationFrame(update); tick = true; } }, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    update();
  });

  /* ---- Playground filter ---- */
  var filters = $$(".play-filter button");
  if (filters.length) {
    filters.forEach(function (b) {
      b.addEventListener("click", function () {
        var f = b.getAttribute("data-filter");
        filters.forEach(function (o) { o.setAttribute("aria-pressed", o === b ? "true" : "false"); });
        $$(".ptile[data-kind]").forEach(function (t) {
          t.classList.toggle("is-hidden", f !== "all" && t.getAttribute("data-kind").indexOf(f) === -1);
        });
      });
    });
  }
  /* ---- Home: the project in view is sharp; the others soften until you scroll to them ---- */
  var wl = $(".work-list");
  if (wl && !reduceMotion) {
    var wcards = $$(".pcard", wl), wTick = false;
    var pickCard = function () {
      wTick = false;
      var mid = window.innerHeight / 2, best = null, bd = Infinity;
      wcards.forEach(function (c) { var r = c.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < bd) { bd = d; best = c; } });
      wcards.forEach(function (c) { c.classList.toggle("is-focus", c === best); });
    };
    wl.classList.add("is-focusing");
    window.addEventListener("scroll", function () { if (!wTick) { wTick = true; requestAnimationFrame(pickCard); } }, { passive: true });
    window.addEventListener("resize", pickCard);
    pickCard();
  }
  /* ---- About: title and photo slide left on scroll to reveal the introduction; experience thumbnail cycles ---- */
  var abh = $("[data-abh]");
  if (abh) {
    var abTrack = $(".ab-h__track", abh), abTick = false;
    var abMove = function () {
      abTick = false;
      if (window.matchMedia("(max-width: 760px)").matches || reduceMotion) { abTrack.style.transform = ""; return; }
      var r = abh.getBoundingClientRect(), run = abh.offsetHeight - window.innerHeight;
      var p = Math.min(1, Math.max(0, -r.top / run));
      var travel = abTrack.scrollWidth - window.innerWidth;
      abTrack.style.transform = "translate3d(" + (-p * travel).toFixed(1) + "px,0,0)";
    };
    window.addEventListener("scroll", function () { if (!abTick) { abTick = true; requestAnimationFrame(abMove); } }, { passive: true });
    window.addEventListener("resize", abMove);
    abMove();
  }
  $$("[data-cycle]").forEach(function (box) {
    var pics = $$("img", box), k = 0;
    if (pics.length < 2 || reduceMotion) return;
    setInterval(function () {
      pics[k].classList.remove("is-on");
      k = (k + 1) % pics.length;
      pics[k].classList.add("is-on");
    }, 1400);
  });
  /* ---- Phone recordings: hover to play on desktop, tap to play on touch screens; 1.5x speed ---- */
  var canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  $$("video[data-hoverplay]").forEach(function (v) {
    var fig = v.closest("figure") || v.parentElement;
    var wrap = document.createElement("div");
    wrap.className = "hp";
    v.parentNode.insertBefore(wrap, v);
    wrap.appendChild(v);
    var badge = document.createElement("span");
    badge.className = "hp__badge";
    badge.setAttribute("aria-hidden", "true");
    badge.innerHTML = "<i></i>" + (canHover ? "Hover to play" : "Tap to play");
    wrap.appendChild(badge);
    v.defaultPlaybackRate = 1.5;
    var fast = function () { v.playbackRate = 1.5; };
    v.addEventListener("loadedmetadata", fast);
    v.addEventListener("play", fast);
    var go = function () { fast(); var p = v.play(); if (p && p.catch) p.catch(function () {}); wrap.classList.add("is-playing"); };
    var stop = function () { v.pause(); wrap.classList.remove("is-playing"); };
    if (canHover) {
      fig.addEventListener("mouseenter", go);
      fig.addEventListener("mouseleave", stop);
    } else {
      wrap.addEventListener("click", function () { if (v.paused) go(); else stop(); });
      if ("IntersectionObserver" in window) new IntersectionObserver(function (es) { es.forEach(function (e) { if (!e.isIntersecting) stop(); }); }).observe(wrap);
    }
  });
  /* ---- Click-to-load YouTube (keeps the page light until someone wants the video) ---- */
  $$("[data-yt]").forEach(function (box) {
    box.addEventListener("click", function () {
      if (box.classList.contains("is-playing")) return;
      var f = document.createElement("iframe");
      f.src = "https://www.youtube-nocookie.com/embed/" + box.getAttribute("data-yt") + "?autoplay=1&rel=0&modestbranding=1";
      f.title = "Nomtopia video";
      f.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen";
      f.allowFullscreen = true;
      box.appendChild(f);
      box.classList.add("is-playing");
    });
  });
  /* Spotify hero: show the title the moment the logo lands in the center */
  var spHero = $(".sp-hero");
  if (spHero) {
    var spLand = function () { spHero.classList.add("is-landed"); };
    var spZoom = $(".spot__zoom", spHero);
    if (reduceMotion || !spZoom) spLand();
    else {
      /* the glide eases out, so the logo is visually centered well before the animation formally ends */
      spZoom.addEventListener("animationstart", function (e) { if (e.animationName === "spZoomReveal") setTimeout(spLand, 1400); });
      spZoom.addEventListener("animationend", function (e) { if (e.animationName === "spZoomReveal") spLand(); });
      setTimeout(spLand, 3200);
    }
  }
})();
