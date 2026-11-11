import type { AnimalType } from "./animals";

// Average gestation length in days per animal type, used when the farm has not configured its own value
export const DEFAULT_GESTATION_DAYS: Record<AnimalType, number> = {
  goat: 150,
  sheep: 147,
  cow: 283,
  horse: 340,
  donkey: 370,
  pig: 115,
  deer: 230,
};
