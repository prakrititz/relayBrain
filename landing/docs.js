/* /.relay docs — syntax highlighting, copy buttons, scrollspy, sidebar filter */
(function () {
  "use strict";

  /* ------------------------------------------------------------ escape -- */

  function esc(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function wrap(cls, text) {
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }

  /* -------------------------------------------------------- highlighter -- */

  var SHELL_WORDS = /^(relay|npm|npx|node|git|gh|cd|ls|mkdir|export|set|curl|ngrok|pnpm|yarn|bun|sudo|open|start)$/;

  // bash: line-oriented so we can treat prompts and full-line comments simply
  function hlBash(src) {
    return src
      .split("\n")
      .map(function (line) {
        var out = "";
        var rest = line;

        // leading whitespace
        var lead = rest.match(/^\s*/)[0];
        out += lead;
        rest = rest.slice(lead.length);

        // prompt
        var prompt = rest.match(/^\$\s+/);
        if (prompt) {
          out += wrap("tok-prompt", prompt[0]);
          rest = rest.slice(prompt[0].length);
        }

        // whole-line comment
        if (/^#/.test(rest)) return out + wrap("tok-comment", rest);
        if (rest === "") return out;

        // trailing comment (" # ...") kept out of the token pass
        var trailing = "";
        var tc = rest.match(/\s+#(?![\w-]*['"]).*$/);
        if (tc) {
          trailing = wrap("tok-comment", tc[0]);
          rest = rest.slice(0, rest.length - tc[0].length);
        }

        var first = true;
        var re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(<[^<>\s][^<>]*>|\[[^\[\]]+\])|(\s--?[A-Za-z][\w-]*)|([^\s|&;()<>[\]"']+)|(\s+)|([\s\S])/g;
        var m;
        while ((m = re.exec(rest)) !== null) {
          if (m[1]) out += wrap("tok-string", m[1]);
          else if (m[2]) out += wrap("tok-placeholder", m[2]);
          else if (m[3]) out += wrap("tok-flag", m[3]);
          else if (m[4]) {
            var word = m[4];
            if (first && SHELL_WORDS.test(word)) out += wrap("tok-cmd", word);
            else if (first) out += wrap("tok-cmd", word);
            else if (/^\d+$/.test(word)) out += wrap("tok-number", word);
            else out += esc(word);
            first = false;
          } else if (m[5]) out += m[5];
          else {
            if (/[|&;]/.test(m[6])) {
              out += wrap("tok-punct", m[6]);
              first = true;
            } else out += esc(m[6]);
          }
        }
        return out + trailing;
      })
      .join("\n");
  }

  function hlJson(src) {
    var re = /("(?:[^"\\]|\\.)*")(\s*:)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?)|([{}\[\],:])|([\s\S])/g;
    var out = "";
    var m;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) {
        out += m[2]
          ? wrap("tok-key", m[1]) + wrap("tok-punct", m[2])
          : wrap("tok-string", m[1]);
      } else if (m[3]) out += wrap("tok-number", m[3]);
      else if (m[4]) out += wrap("tok-number", m[4]);
      else if (m[5]) out += wrap("tok-punct", m[5]);
      else out += esc(m[6]);
    }
    return out;
  }

  function hlDiff(src) {
    return src
      .split("\n")
      .map(function (line) {
        if (/^\+/.test(line)) return wrap("tok-add", line);
        if (/^-/.test(line)) return wrap("tok-del", line);
        if (/^#/.test(line)) return wrap("tok-comment", line);
        return esc(line);
      })
      .join("\n");
  }

  // console output: dim everything, colour ok / BROKE / paths
  function hlOutput(src) {
    return src
      .split("\n")
      .map(function (line) {
        if (/^\s*(ok|✓|OK)\b/.test(line)) return wrap("tok-cmd", line);
        if (/^\s*(BROKE|error|ERROR|✗|failed)\b/.test(line)) return wrap("tok-del", line);
        if (/^\s*#/.test(line)) return wrap("tok-comment", line);
        if (/^\s*\$/.test(line)) return hlBash(line);
        return wrap("tok-dim", line);
      })
      .join("\n");
  }

  var HIGHLIGHTERS = {
    bash: hlBash,
    shell: hlBash,
    json: hlJson,
    diff: hlDiff,
    output: hlOutput,
    text: function (s) { return esc(s); }
  };

  /* ----------------------------------------------------- code block set -- */

  function decorate(block) {
    var pre = block.querySelector("pre");
    var code = pre && pre.querySelector("code");
    if (!code) return;

    var raw = code.textContent.replace(/^\n/, "").replace(/\s+$/, "");
    var lang = (block.getAttribute("data-lang") || "text").toLowerCase();
    var fn = HIGHLIGHTERS[lang] || HIGHLIGHTERS.text;
    code.innerHTML = fn(raw);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code to clipboard");
    btn.addEventListener("click", function () {
      var payload = raw
        .split("\n")
        .map(function (l) { return l.replace(/^\s*\$\s+/, ""); })
        .join("\n");
      var done = function () {
        btn.textContent = "Copied";
        btn.classList.add("is-done");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("is-done");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payload).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = payload;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
    block.appendChild(btn);
  }

  /* ------------------------------------------------------------ ready --- */

  function ready() {
    Array.prototype.forEach.call(document.querySelectorAll(".code-block"), decorate);

    /* -------- build the "on this page" rail from the h2/h3 of the article */
    var rail = document.getElementById("docs-rail");
    var article = document.querySelector(".docs-article");
    if (rail && article) {
      Array.prototype.forEach.call(article.querySelectorAll("section[id]"), function (sec) {
        var h2 = sec.querySelector(":scope > h2, :scope > h1");
        if (h2) {
          var top = document.createElement("a");
          top.href = "#" + sec.id;
          top.textContent = h2.textContent;
          top.className = "rail-top";
          rail.appendChild(top);
        }
        Array.prototype.forEach.call(sec.querySelectorAll(":scope > h3[id]"), function (h) {
          var a = document.createElement("a");
          a.href = "#" + h.id;
          a.textContent = h.textContent;
          a.className = "rail-sub";
          rail.appendChild(a);
        });
      });
    }

    /* ---------------------------------------------------------- scrollspy */
    var sideLinks = document.querySelectorAll(".docs-nav-group a[href^='#']");
    var railLinks = rail ? rail.querySelectorAll("a") : [];
    var targets = [];

    function collect(links) {
      Array.prototype.forEach.call(links, function (a) {
        var el = document.getElementById(a.getAttribute("href").slice(1));
        if (el) targets.push({ el: el, link: a });
      });
    }
    collect(sideLinks);
    collect(railLinks);

    var ticking = false;
    function spy() {
      ticking = false;
      var line = window.scrollY + 140;
      var bestSide = null;
      var bestRail = null;
      targets.forEach(function (t) {
        if (t.el.offsetTop <= line) {
          if (t.link.parentNode && t.link.parentNode.id === "docs-rail") bestRail = t.link;
          else bestSide = t.link;
        }
      });
      Array.prototype.forEach.call(sideLinks, function (a) { a.classList.remove("is-active"); });
      Array.prototype.forEach.call(railLinks, function (a) { a.classList.remove("is-active"); });
      if (bestSide) bestSide.classList.add("is-active");
      if (bestRail) bestRail.classList.add("is-active");
    }

    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(spy);
        }
      },
      { passive: true }
    );
    spy();

    /* ------------------------------------------------------ sidebar filter */
    var search = document.getElementById("docs-search-input");
    var empty = document.querySelector(".docs-nav-empty");
    if (search) {
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        var hits = 0;
        Array.prototype.forEach.call(document.querySelectorAll(".docs-nav-group"), function (group) {
          var groupHits = 0;
          Array.prototype.forEach.call(group.querySelectorAll("a"), function (a) {
            var match = !q || a.textContent.toLowerCase().indexOf(q) !== -1;
            a.classList.toggle("is-hidden", !match);
            if (match) groupHits += 1;
          });
          group.style.display = groupHits ? "" : "none";
          hits += groupHits;
        });
        if (empty) empty.style.display = hits ? "none" : "block";
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "/" && document.activeElement !== search) {
          e.preventDefault();
          search.focus();
        }
      });
    }

    /* ------------------------------------------------------- mobile nav -- */
    var toggle = document.querySelector(".docs-sidebar-toggle");
    var sidebar = document.querySelector(".docs-sidebar");
    if (toggle && sidebar) {
      toggle.addEventListener("click", function () {
        sidebar.classList.toggle("is-open");
      });
      Array.prototype.forEach.call(sidebar.querySelectorAll("a"), function (a) {
        a.addEventListener("click", function () { sidebar.classList.remove("is-open"); });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready);
  } else {
    ready();
  }
})();
