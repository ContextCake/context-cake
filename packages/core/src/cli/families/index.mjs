// Every family in this build, in the order `contextcake help` lists them.
// A family absent here is absent from routing, help, and nextActions alike;
// never register one whose contract is half-built (spec §5.14).

import account from "./account.mjs";
import concept from "./concept.mjs";
import doctor from "./doctor.mjs";
import { ingest, mcp, pack, promote, resolve, write } from "./engine.mjs";
import file from "./file.mjs";
import init from "./init.mjs";
import profile from "./profile.mjs";
import settings from "./settings.mjs";
import source from "./source.mjs";

export const FAMILIES = [
  init,
  profile,
  source,
  settings,
  concept,
  file,
  doctor,
  mcp,
  resolve,
  ingest,
  write,
  promote,
  pack,
  account,
];
