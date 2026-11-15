/**
 * Prints the corpus table: `npm run pricing-corpus --workspace
 * sandbox-factory`, with `PRICING_CORPUS_BANDS="XS:0,XS+:4,S:7,..."` to
 * judge candidate band edges against the same points.
 */

import { RUBRIC_BANDS } from "../../src/index.js";
import { formatReport, parseBands, scoreCorpus } from "./report.js";

const candidate = process.env.PRICING_CORPUS_BANDS;
const bands =
  candidate === undefined || candidate === ""
    ? RUBRIC_BANDS
    : parseBands(candidate);
console.log(formatReport(scoreCorpus(bands), bands));
