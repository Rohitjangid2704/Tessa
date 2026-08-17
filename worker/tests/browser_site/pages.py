LOGIN_EMAIL = "qa@tessa.test"
LOGIN_PASSWORD = "correct-horse-battery"

LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Sign in</title></head>
<body>
<main>
<h1>Sign in</h1>
<form id="login" aria-label="Sign in form">
<p><label for="email">Email</label><input id="email" type="email" autocomplete="off"></p>
<p><label for="password">Password</label>
<input id="password" type="password" data-testid="password" autocomplete="off"></p>
<p><button type="submit">Sign in</button></p>
<p id="error" role="alert" hidden>Invalid credentials</p>
</form>
</main>
<script>
const form = document.getElementById("login");
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  if (email === "__EMAIL__" && password === "__PASSWORD__") {
    window.location.assign("/chat");
  } else {
    document.getElementById("error").hidden = false;
  }
});
</script>
</body>
</html>
""".replace("__EMAIL__", LOGIN_EMAIL).replace("__PASSWORD__", LOGIN_PASSWORD)

CHAT_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Chat</title>
<style>
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
#typing { width: 24px; height: 24px; border: 4px solid #36c; border-top-color: transparent;
 border-radius: 50%; animation: spin 0.8s linear infinite; }
</style></head>
<body>
<main>
<h1>Chat</h1>
<div id="log" role="log" aria-label="Conversation" data-testid="chat-log"></div>
<div id="typing" hidden aria-label="Assistant is typing"></div>
<form id="chat" aria-label="Chat form">
<label for="message">Message</label>
<input id="message" type="text" autocomplete="off" data-testid="chat-input">
<button type="submit" data-testid="send">Send</button>
</form>
</main>
<script>
const params = new URLSearchParams(window.location.search);
console.info("chat ready");
if (params.get("fail") === "console") { console.error("deliberate console error"); }
if (params.get("fail") === "exception") {
  setTimeout(() => { throw new Error("deliberate page error"); }, 50);
}
const log = document.getElementById("log");
const typing = document.getElementById("typing");
function add(author, text) {
  const element = document.createElement("div");
  element.dataset.author = author;
  element.textContent = text;
  log.appendChild(element);
}
document.getElementById("chat").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("message");
  const text = input.value;
  input.value = "";
  add("user", text);
  typing.hidden = false;
  setTimeout(() => { typing.hidden = true; add("assistant", "You said: " + text); }, 400);
});
</script>
</body>
</html>
"""

ANIMATED_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Animated</title>
<style>
body { margin: 0; font-family: sans-serif; }
#bar { position: absolute; top: 120px; left: 0; width: 80px; height: 80px; background: #c33; }
</style></head>
<body>
<h1 id="counter">0</h1>
<div id="bar"></div>
<script>
let n = 0;
const counter = document.getElementById("counter");
const bar = document.getElementById("bar");
function tick(time) {
  counter.textContent = String(++n);
  bar.style.left = ((time / 4) % 1100) + "px";
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script>
</body>
</html>
"""

NOISE_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Noise</title></head>
<body style="margin:0">
<canvas id="c" width="1280" height="720"></canvas>
<script>
const canvas = document.getElementById("c");
const context = canvas.getContext("2d");
const image = context.createImageData(1280, 720);
for (let i = 0; i < image.data.length; i += 4) {
  image.data[i] = (Math.random() * 256) | 0;
  image.data[i + 1] = (Math.random() * 256) | 0;
  image.data[i + 2] = (Math.random() * 256) | 0;
  image.data[i + 3] = 255;
}
context.putImageData(image, 0, 0);
</script>
</body>
</html>
"""

ECHO_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Echo</title></head>
<body><main><h1>Echo</h1><p id="echo" data-testid="echo">__TEXT__</p></main></body>
</html>
"""

STATIC_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Static</title></head>
<body style="background:#eef"><main><h1>Static page</h1><p>Nothing moves here.</p></main></body>
</html>
"""

FORM_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Form</title></head>
<body>
<main>
<h1>Preferences</h1>
<p><label for="color">Colour</label>
<select id="color"><option value="r">Red</option><option value="g">Green</option></select></p>
<p><label><input type="checkbox" id="subscribe"> Subscribe to news</label></p>
<div id="hover" role="note" style="width:200px;height:40px;background:#ddd">Hover over me</div>
<p id="status" role="status"></p>
<p><button id="a">Save</button> <button id="b">Save as</button></p>
</main>
<script>
const status = document.getElementById("status");
document.getElementById("color").addEventListener("change", (event) => {
  status.textContent = "colour " + event.target.value;
});
document.getElementById("subscribe").addEventListener("change", (event) => {
  status.textContent = event.target.checked ? "subscribed" : "unsubscribed";
});
document.getElementById("hover").addEventListener("mouseenter", () => {
  status.textContent = "hovered";
});
document.addEventListener("keydown", (event) => { status.textContent = "key " + event.key; });
</script>
</body>
</html>
"""

FLOOD_PAGE = """<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Test Site - Flood</title></head>
<body><h1>Flood</h1>
<script>
for (let i = 0; i < 400; i++) {
  console.log("message number " + i + " " + "x".repeat(200));
}
</script>
</body>
</html>
"""
