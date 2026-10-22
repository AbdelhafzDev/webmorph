import { createRequire } from 'node:module';

/** The subset of robots-parser we rely on. */
export interface RobotsRules {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
  getCrawlDelay(userAgent?: string): number | undefined;
}

// robots-parser is CommonJS with an ambient type declaration that confuses NodeNext
// resolution, so load it through require and type it here.
const require = createRequire(import.meta.url);
const robotsParser = require('robots-parser') as (url: string, robotsTxt: string) => RobotsRules;

export function parseRobots(robotsUrl: string, robotsTxt: string): RobotsRules {
  return robotsParser(robotsUrl, robotsTxt);
}
