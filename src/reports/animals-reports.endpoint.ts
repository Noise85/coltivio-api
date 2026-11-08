import { z } from "zod";
import { permissionFarmEndpoint } from "../endpoint-factory";
import { ez } from "express-zod-api";
import { animalTypeSchema } from "../db/schema";

const animalsRead = permissionFarmEndpoint("animals", "read");

export const downloadAnimalsReport = animalsRead.build({
  method: "post",
  input: z.object({
    fromDate: ez.dateIn(),
    toDate: ez.dateIn(),
    generateTreatments: z.boolean(),
    generateOutdoorJournal: z.boolean(),
    treatmentAnimalTypes: z.array(animalTypeSchema).optional(),
  }),
  output: z.object({
    base64: z.string(),
    fileName: z.string(),
  }),
  handler: async ({ input, ctx }) => {
    const { buffer, fileName } = await ctx.animalsReports.generateReportBuffer(
      input.fromDate,
      input.toDate,
      input.generateTreatments,
      input.generateOutdoorJournal,
      input.treatmentAnimalTypes
    );
    return { base64: buffer.toString("base64"), fileName };
  },
});
