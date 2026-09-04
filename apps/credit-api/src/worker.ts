import { sql } from "./db/client.js";
import { expireReservations } from "./services/reservations.js";

const expired = await expireReservations();
console.log(`Expired ${expired} reservations`);
await sql.end();
