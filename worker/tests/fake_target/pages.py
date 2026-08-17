LOGIN_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake Target - Sign in</title>
</head>
<body>
<main>
<h1>Sign in</h1>
<form id="login-form" aria-label="Sign in form">
<p><label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required></p>
<p><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password"
 data-testid="password" required></p>
<p><button type="submit">Sign in</button></p>
<p id="login-error" role="alert" hidden></p>
</form>
</main>
<script>
const form = document.getElementById("login-form");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({email: form.email.value, password: form.password.value}),
  });
  if (response.ok) {
    window.location.assign("/chat");
    return;
  }
  const alertBox = document.getElementById("login-error");
  alertBox.textContent = "Invalid email or password";
  alertBox.hidden = false;
});
</script>
</body>
</html>
"""

CHAT_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fake Target - Chat</title>
</head>
<body>
<main>
<h1>Chat</h1>
<div id="chat-log" role="log" aria-live="polite" aria-label="Conversation"
 data-testid="chat-log"></div>
<form id="chat-form" aria-label="Chat form">
<label for="message">Message</label>
<input id="message" name="message" type="text" autocomplete="off" data-testid="chat-input">
<button type="submit" data-testid="send">Send</button>
</form>
</main>
<script>
const log = document.getElementById("chat-log");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
if (new URLSearchParams(window.location.search).get("fail") === "console") {
  console.error("fake target deliberate console error");
}
console.info("chat ready");

function addMessage(author, text) {
  const element = document.createElement("div");
  element.setAttribute("data-testid", "message");
  element.setAttribute("data-author", author);
  element.textContent = text;
  log.appendChild(element);
  return element;
}

function parseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split("\\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return {event, data: data.join("\\n")};
}

function addConfirmation(card) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Confirm";
  button.setAttribute("data-testid", "confirm");
  button.addEventListener("click", async () => {
    button.disabled = true;
    const response = await fetch("/api/issues", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({room: card.room, description: card.description}),
    });
    addMessage("assistant", response.ok ? "Issue created" : "Issue could not be created");
  });
  log.appendChild(button);
}

function handle(message, reply) {
  const payload = JSON.parse(message.data);
  if (message.event === "token") {
    reply.textContent += payload.text;
  } else if (message.event === "card" && payload.kind === "confirmation") {
    addConfirmation(payload);
  }
}

async function ask(text) {
  addMessage("user", text);
  const reply = addMessage("assistant", "");
  const response = await fetch("/api/chat/message", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({message: text}),
  });
  if (!response.ok) {
    reply.textContent = "Request failed";
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {stream: true});
    const blocks = buffer.split("\\n\\n");
    buffer = blocks.pop();
    for (const block of blocks) {
      handle(parseBlock(block), reply);
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) {
    return;
  }
  input.value = "";
  ask(text);
});
</script>
</body>
</html>
"""
