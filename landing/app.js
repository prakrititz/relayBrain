const entries = [
  ["10:04", "Pony / Claude Code", "claim src/auth/session.ts — lock held 15s"],
  ["10:06", "Unnath / Cursor", "blocked on src/auth/session.ts — waiting on @pony"],
  ["10:09", "Arjun / Codex", "claim lib/db/client.ts — dep graph: 4 dependents guarded"],
  ["10:11", "/.RELAY ROOM", "patch pushed → 3 peers on the same working state"],
  ["10:12", "New machine joined", "mirrored 4 live locks over the tunnel in 0.3s"]
];

const stream = document.querySelector("#memory-stream");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let timers = [];

function updateNetworkConnectors() {
  const network = document.querySelector(".network");
  const svg = network?.querySelector(".network-lines");
  const brain = network?.querySelector(".brain-core");

  if (!network || !svg || !brain) return;

  const svgRect = svg.getBoundingClientRect();
  const brainRect = brain.getBoundingClientRect();
  const target = {
    x: brainRect.left + brainRect.width / 2 - svgRect.left,
    y: brainRect.top + brainRect.height / 2 - svgRect.top
  };

  svg.setAttribute("viewBox", `0 0 ${svgRect.width} ${svgRect.height}`);

  network.querySelectorAll("[data-tool]").forEach((node) => {
    const name = node.dataset.tool;
    const iconRect = node.querySelector(".tool-icon").getBoundingClientRect();
    const start = {
      x: iconRect.left + iconRect.width / 2 - svgRect.left,
      y: iconRect.top + iconRect.height / 2 - svgRect.top
    };
    const path = svg.querySelector(`[data-connector="${name}"]`);
    const endpoint = svg.querySelector(`[data-endpoint="${name}"]`);
    const vertical = Math.abs(target.y - start.y) > Math.abs(target.x - start.x) * 1.5;

    if (vertical) {
      const midY = start.y + (target.y - start.y) * 0.55;
      path.setAttribute("d", `M ${start.x} ${start.y} C ${start.x} ${midY}, ${target.x} ${midY}, ${target.x} ${target.y}`);
    } else {
      const midX = start.x + (target.x - start.x) * 0.55;
      path.setAttribute("d", `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${target.y}, ${target.x} ${target.y}`);
    }

    endpoint.setAttribute("cx", start.x);
    endpoint.setAttribute("cy", start.y);
  });
}

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

updateNetworkConnectors();
window.addEventListener("load", updateNetworkConnectors);

const networkResizeObserver = new ResizeObserver(updateNetworkConnectors);
const network = document.querySelector(".network");
if (network) networkResizeObserver.observe(network);

// Data Carousel
const carousel = document.querySelector('.data-carousel');
const prevBtn = document.querySelector('.prev-slide');
const nextBtn = document.querySelector('.next-slide');

if (carousel && prevBtn && nextBtn) {
  nextBtn.addEventListener('click', () => {
    carousel.scrollBy({ left: carousel.offsetWidth, behavior: 'smooth' });
  });
  prevBtn.addEventListener('click', () => {
    carousel.scrollBy({ left: -carousel.offsetWidth, behavior: 'smooth' });
  });
}
