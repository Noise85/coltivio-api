import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, request } from "./helpers";
import {
  createUserWithFarm,
  createContact,
  createAnimal,
  createSponsorship,
  createSponsorshipProgram,
  createPayment,
} from "./test-utils";

describe("Sponsorships", () => {
  beforeEach(cleanDb);

  it("retrieves sponsorship by id with sponsorshipProgram included", async () => {
    const { jwt } = await createUserWithFarm({}, undefined);
    const contact = await createContact(jwt);
    const animal = await createAnimal(jwt);
    const program = await createSponsorshipProgram(jwt, { yearlyCost: 150 });
    const sponsorship = await createSponsorship(jwt, contact.id, animal.id, program.id);

    const res = await request("GET", `/v1/sponsorships/byId/${sponsorship.id}`, undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    const fetched = body.data;

    expect(fetched.id).toBe(sponsorship.id);
    expect(fetched.sponsorshipProgram).toBeDefined();
    expect((fetched.sponsorshipProgram as Record<string, unknown>).id).toBe(program.id);
    expect((fetched.sponsorshipProgram as Record<string, unknown>).yearlyCost).toBe(150);
    expect(fetched.contact).toBeDefined();
    expect(fetched.animal).toBeDefined();
    expect(Array.isArray(fetched.payments)).toBe(true);
  });

  describe("GET /v1/sponsorships — paidThisYear flag", () => {
    it("returns paidThisYear=false when no payments exist", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const animal = await createAnimal(jwt);
      const program = await createSponsorshipProgram(jwt, { yearlyCost: 200 });
      await createSponsorship(jwt, contact.id, animal.id, program.id);

      const res = await request("GET", "/v1/sponsorships", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { result: Array<Record<string, unknown>> };
      };
      const sponsorships = body.data.result;
      expect(sponsorships).toHaveLength(1);
      expect(sponsorships[0].paidThisYear).toBe(false);
    });

    it("returns paidThisYear=false when payments are insufficient", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const animal = await createAnimal(jwt);
      const program = await createSponsorshipProgram(jwt, { yearlyCost: 200 });
      const sponsorship = await createSponsorship(jwt, contact.id, animal.id, program.id);

      // Pay only 100 of 200 required
      await createPayment(jwt, contact.id, {
        sponsorshipId: sponsorship.id,
        amount: 100,
        date: "2026-06-01",
      });

      const res = await request("GET", "/v1/sponsorships", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { result: Array<Record<string, unknown>> };
      };
      expect(body.data.result[0].paidThisYear).toBe(false);
    });

    it("returns paidThisYear=true when payments for this year cover yearlyCost", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const animal = await createAnimal(jwt);
      const program = await createSponsorshipProgram(jwt, { yearlyCost: 200 });
      const sponsorship = await createSponsorship(jwt, contact.id, animal.id, program.id);

      // Two payments of 100 each in 2026
      await createPayment(jwt, contact.id, {
        sponsorshipId: sponsorship.id,
        amount: 100,
        date: "2026-03-01",
      });
      await createPayment(jwt, contact.id, {
        sponsorshipId: sponsorship.id,
        amount: 100,
        date: "2026-06-01",
      });

      const res = await request("GET", "/v1/sponsorships", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { result: Array<Record<string, unknown>> };
      };
      expect(body.data.result[0].paidThisYear).toBe(true);
    });

    it("does not count payments from previous years toward paidThisYear", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const animal = await createAnimal(jwt);
      const program = await createSponsorshipProgram(jwt, { yearlyCost: 200 });
      const sponsorship = await createSponsorship(jwt, contact.id, animal.id, program.id);

      // Full payment but in a previous year
      await createPayment(jwt, contact.id, {
        sponsorshipId: sponsorship.id,
        amount: 200,
        date: "2025-12-01",
      });

      const res = await request("GET", "/v1/sponsorships", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { result: Array<Record<string, unknown>> };
      };
      expect(body.data.result[0].paidThisYear).toBe(false);
    });

    it("includes sponsorshipProgram in the list response", async () => {
      const { jwt } = await createUserWithFarm({}, undefined);
      const contact = await createContact(jwt);
      const animal = await createAnimal(jwt);
      const program = await createSponsorshipProgram(jwt, { name: "Gold", yearlyCost: 500 });
      await createSponsorship(jwt, contact.id, animal.id, program.id);

      const res = await request("GET", "/v1/sponsorships", undefined, jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { result: Array<Record<string, unknown>> };
      };
      const sp = body.data.result[0];
      expect(sp.sponsorshipProgram).toBeDefined();
      const prog = sp.sponsorshipProgram as Record<string, unknown>;
      expect(prog.id).toBe(program.id);
      expect(prog.name).toBe("Gold");
      expect(prog.yearlyCost).toBe(500);
    });
  });
});
