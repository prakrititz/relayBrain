const entries = [
  ["10:04", "Pony / Claude Code", "auth: JWT over sessions (stateless, mobile-ready)"],
  ["10:06", "Unnath / Copilot", "rate_limit: 100 req/min per IP, express-rate-limit"],
  ["10:09", "Arjun / Codex", "proposed: use tRPC instead of REST [2 votes pending]"],
  ["10:11", "/.RELAY MEMORY", "#48 committed - \"tRPC decision\" (3/3 voted)"],
  ["10:12", "New member joined", "synced 847 memory entries in 0.3s"]
];

const stream = document.querySelector("#memory-stream");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let timers = [];

function makeLine([time, source, text]) {
  const line = document.createElement("div");
  line.className = "stream-line";
  line.innerHTML = `
    <span class="stream-time">[${time}]</span>
    <span class="stream-source">${source}</span>
    <span class="stream-text"></span>
  `;
  line.dataset.text = `→ ${text}`;
  return line;
}

function clearTimers() {
  timers.forEach(window.clearTimeout);
  timers = [];
}

function typeLine(line, done) {
  const target = line.querySelector(".stream-text");
  const text = line.dataset.text;
  let index = 0;

  line.classList.add("visible");
  target.classList.add("stream-cursor");

  function typeNext() {
    target.textContent = text.slice(0, index);
    index += 1;
    if (index <= text.length) {
      timers.push(window.setTimeout(typeNext, 16));
    } else {
      target.classList.remove("stream-cursor");
      done();
    }
  }

  typeNext();
}

function runStream() {
  clearTimers();
  stream.replaceChildren(...entries.map(makeLine));
  const lines = [...stream.children];

  if (reducedMotion) {
    lines.forEach((line) => {
      line.classList.add("visible");
      line.querySelector(".stream-text").textContent = line.dataset.text;
    });
    return;
  }

  function reveal(index) {
    if (index >= lines.length) {
      timers.push(window.setTimeout(runStream, 3000));
      return;
    }
    typeLine(lines[index], () => {
      timers.push(window.setTimeout(() => reveal(index + 1), 520));
    });
  }

  reveal(0);
}

runStream();
