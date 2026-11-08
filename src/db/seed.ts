import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const _db = drizzle({ client: pool, schema });

async function main() {
  // const [battesta] = await db
  //   .insert(members)
  //   .values([
  //     {
  //       name: "Mr. Battesta",
  //       email: "battesta@miadi.ch",
  //       username: "battesta",
  //     },
  //     {
  //       name: "Mr. Batman",
  //       email: "batman@miadi.ch",
  //       username: "batman",
  //     },
  //     {
  //       name: "Mr. Super",
  //       email: "superman@foo.ch",
  //       username: "super",
  //     },
  //   ])
  //   .returning({ id: members.id });
  // await db.transaction(async (tx) => {
  //   const [farm] = await tx
  //     .insert(farms)
  //     .values({
  //       name: "Agri Miadi",
  //       federalId: "GR3837/ 1/105",
  //       tvdId: "1070323",
  //       ownerId: battesta.id,
  //       location: sql`ST_MakePoint(9.123333, 46.307513)`,
  //     })
  //     .returning({ id: farms.id });
  //   await tx.insert(farmUsers).values({
  //     farmId: farm.id,
  //     userId: battesta.id,
  //     role: "ADMIN",
  //   });
  // });
}
main()
  .then(async () => {})
  .catch(async (e) => {
    // process.exit(1);
    console.log(e);
  })
  .finally(async () => {
    await pool.end();
  });
