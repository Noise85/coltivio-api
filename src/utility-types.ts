export type NullAsUndefined<T> = T extends null
  ? undefined // Note: Add interfaces here of all GraphQL scalars that will be transformed into an object
  : T extends Date
    ? T
    : {
        [K in keyof T]: T[K] extends (infer U)[] ? NullAsUndefined<U>[] : NullAsUndefined<T[K]>;
      };

export type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;
