import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { NullableString } from './primitives.js';

export const ProjectLabelSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: Type.Union([
    Type.Literal('git'), Type.Literal('app'), Type.Literal('session'),
    Type.Literal('project'), Type.Literal('unknown'),
  ]),
});
export type ProjectLabel = Static<typeof ProjectLabelSchema>;

export const MetaSchema = Type.Object({
  exampleData: Type.Optional(Type.Boolean()),
  source: Type.String(),
  updatedAt: NullableString,
  timezone: Type.String(),
  warnings: Type.Array(Type.String()),
  projectLabels: Type.Optional(Type.Array(ProjectLabelSchema)),
  devices: Type.Optional(Type.Array(Type.Object({id:Type.String(),name:Type.String(),coverageFrom:NullableString,coverageTo:NullableString}))),
  conflictCount: Type.Optional(Type.Integer()),
  provider: Type.Optional(Type.Union([Type.Literal("app-server"), Type.Literal("http"), Type.Null()])),
  accountId: Type.Optional(NullableString),
  identityConfirmed: Type.Optional(Type.Boolean()),
  stale: Type.Optional(Type.Boolean()),
});

export type Meta = Static<typeof MetaSchema>;

export const ResponseSchema = <T extends TSchema>(schema: T) =>
  Type.Object({ data: schema, meta: MetaSchema });

export type ApiResponse<T> = { data: T; meta: Meta };

export const PageSchema = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  });

export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};

export const ErrorSchema = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
