/** Prints the pipeline. `npm run leads` */
import { allLeads } from "../src/store.js";
import { label } from "../src/slots.js";

const rows = allLeads();
if (!rows.length) {
  console.log("\nNo leads yet.\n");
  process.exit(0);
}

const pad = (s, n) =>
  String(s ?? "-")
    .slice(0, n)
    .padEnd(n);

console.log();
console.log(
  pad("NUMBER", 14) +
    pad("LANG", 5) +
    pad("STATE", 17) +
    pad("SHOP", 26) +
    "SLOT",
);
console.log("-".repeat(96));
for (const l of rows) {
  console.log(
    pad("+" + l.wa_id, 14) +
      pad(l.lang, 5) +
      pad(l.state + (l.human_takeover ? "*" : ""), 17) +
      pad(l.shop_name, 26) +
      (l.slot_iso ? label(new Date(l.slot_iso), "en") : "-"),
  );
}

const by = (k) => rows.filter((r) => r.state === k).length;
console.log("-".repeat(96));
console.log(
  `${rows.length} leads  |  booked ${by("BOOKED")}  |  awaiting slot ${by("AWAITING_SLOT")}  ` +
    `|  awaiting details ${by("AWAITING_DETAILS")}  |  needs you ${rows.filter((r) => r.human_takeover).length}  ` +
    `|  declined ${by("DECLINED")}`,
);
console.log("* = human has taken over\n");
