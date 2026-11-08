import { TFunction } from "i18next";
import { CropCreateInput } from "./crops";

export const UNKNOWN_CROP_CODE = -1;

export function mapCodesToCrops(codes: number[], t: TFunction): CropCreateInput[] {
  const cropsByName: Record<string, Omit<CropCreateInput, "usageCodes"> & { usageCodes: Set<number> }> = {
    [t("crops.natural_meadow")]: {
      name: t("crops.natural_meadow"),
      category: "grass",
      usageCodes: new Set<number>(),
    },
  };
  for (const code of codes) {
    const isDefined = usageCodes.includes(code);
    // @ts-ignore
    const name: string = t(`crops.codes.${isDefined ? code.toString() : "-1"}`);
    if (!cropsByName[name]) {
      cropsByName[name] = {
        name,
        category: mapCodeToCategory(code),
        usageCodes: new Set([code]),
      };
    } else {
      cropsByName[name].usageCodes!.add(code);
    }
  }
  return Object.values(cropsByName).map((crop) => ({
    ...crop,
    usageCodes: Array.from<number>(crop.usageCodes),
  }));
}

function mapCodeToCategory(code: number): CropCreateInput["category"] {
  switch (code) {
    // 🌾 grain
    case 501:
    case 502:
    case 504:
    case 505:
    case 506:
    case 507:
    case 508:
    case 510:
    case 511:
    case 512:
    case 513:
    case 514:
    case 515:
    case 516:
    case 519:
    case 520:
    case 521:
    case 529:
    case 531:
    case 534:
    case 536:
    case 537:
    case 538:
    case 539:
    case 540:
    case 543:
    case 544:
    case 566:
    case 567:
    case 568:
    case 569:
    case 570:
    case 573:
    case 574:
    case 575:
    case 576:
    case 577:
    case 578:
    case 579:
    case 580:
    case 581:
    case 591:
    case 592:
    case 626:
    case 951:
      return "grain";

    // 🌿 grass
    case 601:
    case 602:
    case 611:
    case 612:
    case 613:
    case 616:
    case 617:
    case 618:
    case 621:
    case 622:
    case 623:
    case 625:
    case 631:
    case 632:
    case 635:
    case 660:
    case 693:
    case 694:
    case 697:
    case 698:
    case 930:
    case 933:
    case 935:
    case 936:
      return "grass";

    // 🥕 vegetable
    case 522:
    case 523:
    case 524:
    case 525:
    case 545:
    case 546:
    case 709:
    case 710:
    case 711:
    case 801:
    case 811:
    case 812:
    case 810:
      return "vegetable";

    // 🍎 fruit
    case 551:
    case 702:
    case 703:
    case 704:
    case 705:
    case 701:
    case 703:
    case 720:
    case 717:
    case 730:
    case 731:
    case 804:
    case 813:
    case 814:
    case 922:
    case 923:
    case 921:
      return "fruit";

    // 🧱 other
    default:
      return "other";
  }
}

export function isKnownUsageCode(code: number): boolean {
  return usageCodes.includes(code);
}

const usageCodes = [
  501, 502, 504, 505, 506, 507, 508, 510, 511, 512, 513, 514, 515, 516, 519, 520, 521, 522, 523, 524, 525, 526, 527,
  528, 529, 531, 534, 536, 537, 538, 539, 540, 541, 543, 544, 545, 546, 548, 551, 552, 553, 554, 556, 557, 559, 566,
  567, 568, 569, 570, 572, 573, 574, 575, 576, 577, 578, 579, 580, 581, 591, 592, 594, 595, 597, 598, 601, 602, 611,
  612, 613, 616, 617, 618, 621, 622, 623, 625, 631, 632, 635, 660, 693, 694, 697, 698, 701, 702, 703, 704, 705, 706,
  707, 708, 709, 710, 711, 712, 713, 714, 717, 718, 719, 720, 721, 722, 723, 724, 725, 730, 731, 735, 797, 798, 801,
  802, 803, 804, 807, 808, 810, 811, 812, 813, 814, 830, 847, 848, 849, 851, 852, 857, 858, 897, 898, 901, 902, 903,
  904, 905, 906, 907, 908, 909, 911, 921, 922, 923, 924, 926, 927, 928, 930, 933, 935, 936, 950, 951, 998,
];
