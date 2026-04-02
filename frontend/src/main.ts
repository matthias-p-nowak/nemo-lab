// Entry point — opens the WebSocket connection to the server.
const ws = new WebSocket(`ws://${location.host}/ws`);

ws.addEventListener("open", () => console.log("ws: connected"));
ws.addEventListener("close", () => console.log("ws: disconnected"));
ws.addEventListener("error", (e) => console.error("ws: error", e));

