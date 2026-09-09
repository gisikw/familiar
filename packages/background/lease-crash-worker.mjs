import { acquireHostLease } from "./lease.mjs";
await acquireHostLease(process.argv[2]);
process.stdout.write("ready\n");
setInterval(() => {}, 1000);
