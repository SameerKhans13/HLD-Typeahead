import { app } from "./server";

app.get("/", () => Bun.file("public/index.html"));

app.listen(3000);

console.log(
  `🦊 Elysia is running at http://${app.server?.hostname || "localhost"}:${app.server?.port || 3000}`
);
