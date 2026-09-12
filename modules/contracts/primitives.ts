import { Type } from "@sinclair/typebox";

export const NullableString = Type.Union([Type.String(), Type.Null()]);

export const IntegerText = Type.String({ pattern: "^-?[0-9]+$" });

export const NullableInteger = Type.Union([IntegerText, Type.Null()]);

export const Ratio = Type.Union([Type.Number(), Type.Null()]);

export const Price = Type.Union([
    Type.String({ pattern: "^[0-9]{1,8}(\\.[0-9]{1,6})?$" }),
    Type.Null(),
]);
