// Always an isolated, loopback-only workspace. Real .env credentials are ignored.
process.env.NODE_ENV = "development";
process.env.DRY_RUN = "1";
process.env.DB_FILE = "./data/demo.db";
process.env.HOST = "127.0.0.1";
process.env.PORT = process.env.DEMO_PORT || "3000";
process.env.ADMIN_TOKEN = "ledger-demo-access-token-local-only";
process.env.OWNER_WHATSAPP = "";
process.env.NOTIFY_WEBHOOK = "";
const { seedDemo } = await import("./demo-data.js");
await seedDemo();
console.log(
  `\nDemo: http://127.0.0.1:${process.env.PORT}\nAccess token: ${process.env.ADMIN_TOKEN}\nSynthetic contacts only. No external services are called.\n`,
);
await import("../src/server.js");
