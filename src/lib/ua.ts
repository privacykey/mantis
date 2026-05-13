import { UAParser } from "ua-parser-js";

export type ParsedUA = {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  device: string | null;
  botLabel: string | null;
};

const BOT_PATTERNS: Array<[RegExp, string]> = [
  [/googlebot/i, "googlebot"],
  [/bingbot/i, "bingbot"],
  [/yandex(bot|images)/i, "yandexbot"],
  [/duckduckbot/i, "duckduckbot"],
  [/baiduspider/i, "baiduspider"],
  [/applebot/i, "applebot"],
  [/facebookexternalhit|facebot/i, "facebookbot"],
  [/twitterbot/i, "twitterbot"],
  [/linkedinbot/i, "linkedinbot"],
  [/slackbot/i, "slackbot"],
  [/discordbot/i, "discordbot"],
  [/telegrambot/i, "telegrambot"],
  [/whatsapp/i, "whatsapp"],
  [/headlesschrome/i, "headless-chrome"],
  [/phantomjs/i, "phantomjs"],
  [/puppeteer/i, "puppeteer"],
  [/playwright/i, "playwright"],
  [/python-requests/i, "python-requests"],
  [/python-urllib/i, "python-urllib"],
  [/httpie/i, "httpie"],
  [/^curl\//i, "curl"],
  [/^wget\//i, "wget"],
  [/go-http-client/i, "go-http-client"],
  [/java\//i, "java-client"],
  [/okhttp/i, "okhttp"],
  [/postmanruntime/i, "postman"],
  [/insomnia/i, "insomnia"],
  // Generic catch-alls last
  [/bot|crawl|spider|scraper/i, "generic-bot"],
];

export function parseUserAgent(ua: string | null): ParsedUA {
  if (!ua) {
    return {
      browser: null,
      browserVersion: null,
      os: null,
      device: null,
      botLabel: null,
    };
  }

  const botLabel = detectBot(ua);
  const parser = new UAParser(ua);
  const result = parser.getResult();

  const deviceType =
    result.device?.type ?? (botLabel ? "bot" : "desktop");

  return {
    browser: result.browser?.name ?? null,
    browserVersion: result.browser?.version ?? null,
    os: result.os?.name ?? null,
    device: deviceType ?? null,
    botLabel,
  };
}

function detectBot(ua: string): string | null {
  for (const [pattern, label] of BOT_PATTERNS) {
    if (pattern.test(ua)) return label;
  }
  return null;
}
