import { z } from "zod";
import { authenticatedEndpointFactory } from "../endpoint-factory";
import { BBox } from "../geo/geojson";
import { ez } from "express-zod-api";
import { multiPolygonSchema } from "../db/schema";

// Clients only ever ask for one map viewport or the surroundings of one point.
// Anything larger would stream a large part of the 1.7M-row table through the
// API process, so bigger requests are rejected instead of served.
const MAX_BBOX_SIDE_DEGREES = 0.1; // about 7 x 11 km
const MAX_RADIUS_KM = 5;
const MAX_FEDERAL_FARM_ID_RESULTS = 100;

// Query parameters arrive as strings and stay documented as such for the clients
const numberParam = (bounds: z.ZodNumber) => z.string().transform(Number).pipe(bounds);
const longitude = numberParam(z.number().min(-180).max(180));
const latitude = numberParam(z.number().min(-90).max(90));
const radiusInKm = numberParam(z.number().positive().max(MAX_RADIUS_KM));

// Floating point: 47.1 - 47 lands slightly above 0.1
const withinSideLimit = (size: number) => size <= MAX_BBOX_SIDE_DEGREES + 1e-9;

const BoundingBoxSchema = z
  .object({ xmin: longitude, ymin: latitude, xmax: longitude, ymax: latitude })
  .refine(({ xmin, ymin, xmax, ymax }) => xmax > xmin && ymax > ymin, {
    message: "bounding box must have a positive extent",
  })
  .refine(({ xmin, ymin, xmax, ymax }) => withinSideLimit(xmax - xmin) && withinSideLimit(ymax - ymin), {
    message: `bounding box sides must not exceed ${MAX_BBOX_SIDE_DEGREES} degrees`,
  });

const selectFederalFarmPlotSchema = z.object({
  id: z.number(),
  federalFarmId: z.string(),
  localId: z.string().nullable(),
  usage: z.number(),
  size: z.number(),
  cuttingDate: ez.dateOut().nullable(),
  canton: z.string(),
  geometry: multiPolygonSchema,
});

export const getPlotsLayerForBoundingBoxEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: BoundingBoxSchema,
  output: z.object({
    result: selectFederalFarmPlotSchema.array(),
    count: z.number(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    // bbox: z.object({
    //   xmin: z.number(),
    //   xmax: z.number(),
    //   ymin: z.number(),
    //   ymax: z.number(),
    // }),
  }),
  handler: async ({ input: { xmax, xmin, ymax, ymin }, ctx: { federalParcelLayer } }) => {
    const parcels = await federalParcelLayer.getPlotsLayerForBoundingBox(xmin, ymin, xmax, ymax);
    const bbox: BBox = [xmin, ymin, xmax, ymax];

    return {
      result: parcels,
      bbox,
      count: parcels.length,
    };
  },
});

export const getPlotsForFederalFarmIdEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({ federalFarmId: z.string() }),
  output: z.object({
    result: selectFederalFarmPlotSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input: { federalFarmId }, ctx: { federalParcelLayer } }) => {
    const parcels = await federalParcelLayer.getPlotsForFederalFarmId(federalFarmId);
    return {
      result: parcels,
      count: parcels.length,
    };
  },
});

export const getFarmAndNearbyPlotsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({
    federalFarmId: z.string(),
    buffer: radiusInKm.optional(),
  }),
  output: z.object({
    result: selectFederalFarmPlotSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input: { federalFarmId, buffer }, ctx: { federalParcelLayer } }) => {
    const parcels = await federalParcelLayer.getFarmAndNearbyPlots(federalFarmId, buffer);
    return {
      result: parcels,
      count: parcels.length,
    };
  },
});
export const getPlotsWithinRadiusOfPointEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({ longitude, latitude, radiusInKm }),
  output: z.object({
    result: selectFederalFarmPlotSchema.array(),
    count: z.number(),
  }),
  handler: async ({ input: { longitude, latitude, radiusInKm }, ctx: { federalParcelLayer } }) => {
    const parcels = await federalParcelLayer.getPlotsWithinRadiusOfPoint(longitude, latitude, radiusInKm);
    return {
      result: parcels,
      count: parcels.length,
    };
  },
});

export const getFederalFarmIdsEndpoint = authenticatedEndpointFactory.build({
  method: "get",
  input: z.object({
    query: z.string(),
    longitude,
    latitude,
    radiusInKm,
    limit: numberParam(z.number().int().positive().max(MAX_FEDERAL_FARM_ID_RESULTS)),
  }),
  output: z.object({
    result: z.array(z.string()),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { federalParcelLayer } }) => {
    const federalFarmIds = await federalParcelLayer.getFederalFarmIds(
      input.query,
      input.longitude,
      input.latitude,
      input.radiusInKm,
      input.limit
    );
    return {
      result: federalFarmIds,
      count: federalFarmIds.length,
    };
  },
});
