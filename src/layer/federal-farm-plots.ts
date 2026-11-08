import { eq, sql, and, getColumns } from "drizzle-orm";
import { RlsDb } from "../db/db";
import { federalFarmPlots } from "../db/schema";
import { MultiPolygon } from "../geo/geojson";

const plotSelectColumns = {
  ...getColumns(federalFarmPlots),
  geometry: sql<MultiPolygon>`ST_AsGeoJSON(${federalFarmPlots.geometry})::json`,
};

// Backstop for the extent limits in layer.endpoint.ts: a dense 0.1 degree box
// holds under 10k plots, and every row carries its full polygon as GeoJSON.
export const MAX_PLOT_ROWS = 10000;

export function federalPlotsLayerApi(authDb: RlsDb) {
  return {
    async getPlotsForFederalFarmId(federalFarmId: string) {
      return authDb.rls(async (tx) => {
        return tx
          .select(plotSelectColumns)
          .from(federalFarmPlots)
          .where(eq(federalFarmPlots.federalFarmId, federalFarmId));
      });
    },
    async getFarmAndNearbyPlots(federalId: string, radiusInKm: number = 1) {
      return authDb.rls(async (tx) => {
        // const result = await tx.execute(
        //   sql.raw(`select current_setting('search_path')`)
        // );
        // const result2 = await tx.execute(sql.raw(`select current_role`));
        // console.log(result);
        // console.log(result2);
        const radiusInDegrees = (radiusInKm * 1000) / 111000.0;
        const bufferedBbox = tx.$with("buffered_bbox").as(
          tx
            .select({
              bbox: sql`ST_Buffer(ST_Envelope(ST_Union(${federalFarmPlots.geometry}))::geometry, ${radiusInDegrees})`.as(
                "bbox"
              ),
            })
            .from(federalFarmPlots)
            .where(eq(federalFarmPlots.federalFarmId, federalId))
        );

        return tx
          .with(bufferedBbox)
          .select(plotSelectColumns)
          .from(federalFarmPlots)
          .where(
            sql`ST_Intersects(${federalFarmPlots.geometry}, ${sql`(select ${bufferedBbox.bbox} from ${bufferedBbox})`})`
          )
          .limit(MAX_PLOT_ROWS);
      });
    },
    async getPlotsWithinRadiusOfPoint(longitude: number, latitude: number, radiusInKm: number) {
      return authDb.rls(async (tx) => {
        // we nee to convert the meters in radius. this is a very rough approximation but good enough for us
        const radiusInDegrees = (radiusInKm * 1000) / 111000.0;

        return tx
          .select(plotSelectColumns)
          .from(federalFarmPlots)
          .where(
            sql`ST_DWithin(
        ${federalFarmPlots.geometry},
        ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326), 
        ${radiusInDegrees}
      )`
          )
          .limit(MAX_PLOT_ROWS);
      });
    },
    async getPlotsLayerForBoundingBox(xmin: number, ymin: number, xmax: number, ymax: number) {
      return authDb.rls(async (tx) => {
        return tx
          .select(plotSelectColumns)
          .from(federalFarmPlots)
          .where(
            sql`
        ST_Intersects(
           geometry,
        ST_MakeEnvelope(${xmin}, ${ymin}, ${xmax}, ${ymax}, 4326)
      )
      `
          )
          .limit(MAX_PLOT_ROWS);
      });
    },
    async getFederalFarmIds(
      query: string,
      longitude: number,
      latitude: number,
      radiusInKm: number,
      limit: number
    ): Promise<string[]> {
      return authDb.rls(async (tx) => {
        await tx.execute(sql.raw("select set_limit(0.2)"));
        const radiusInDegrees = (radiusInKm * 1000) / 111000.0;
        console.log("radiusInDegrees", radiusInDegrees);
        const result = await tx
          .selectDistinct({
            federalFarmId: federalFarmPlots.federalFarmId,
            similarity: sql`similarity(${federalFarmPlots.federalFarmId}, ${query})`,
          })
          .from(federalFarmPlots)
          .where(
            and(
              sql`ST_DWithin(
        ${federalFarmPlots.geometry},
        ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326), 
        ${radiusInDegrees}
      )`,
              sql`${federalFarmPlots.federalFarmId} % ${query}`
            )
          )
          .orderBy(sql`similarity desc`)
          .limit(limit);
        return result.map(({ federalFarmId }) => federalFarmId);
      });
    },
  };
}
