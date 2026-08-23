import type { components } from "@/lib/api/schema";
import type { InterimSchemas } from "@/lib/api/types";

type Schemas = components["schemas"];

export type Catalog = Schemas["Catalog"];
export type CatalogArea = Schemas["CatalogArea"];
export type CatalogItem = Schemas["CatalogItem"] &
  Partial<InterimSchemas["CatalogItemProposalFields"]>;
export type CatalogExample = Schemas["CatalogExample"];
export type CatalogRole = Schemas["CatalogRole"];
export type CatalogInterface = Schemas["CatalogInterface"];
export type FeatureKind = Schemas["FeatureKind"];
export type Confidence = Schemas["Confidence"];
export type AdapterKind = Schemas["AdapterKind"];
