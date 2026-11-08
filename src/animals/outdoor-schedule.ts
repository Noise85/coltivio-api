import { RlsDb } from "../db/db";

export function outdoorScheduleApi(rlsDb: RlsDb) {
  return {
    async getOutdoorSchedules(from: Date, to: Date) {
      return rlsDb.rls(async (tx) => {
        return tx.query.outdoorSchedules.findMany({
          where: {
            AND: [{ startDate: { lte: to } }, { startDate: { gte: from } }],
          },
          with: {
            herd: {
              with: {
                animals: true,
              },
            },
            recurrence: true,
          },
        });
      });
    },
  };
}
