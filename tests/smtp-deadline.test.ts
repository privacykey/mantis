import nodemailer from "nodemailer";
import { expect, it } from "vitest";
import { boundedSmtpUrl } from "@/lib/notify/smtp";

it("applies SMTP deadlines to the real transport while preserving auth and TLS options", () => {
  const transport = nodemailer.createTransport(boundedSmtpUrl("smtps://name%40example.test:p%3Ass@smtp.example.test:465?tls.rejectUnauthorized=true&socketTimeout=90000"));
  expect(transport.options).toMatchObject({ host: "smtp.example.test", port: 465, secure: true,
    auth: { user: "name@example.test", pass: "p:ss" }, tls: { rejectUnauthorized: true },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 });
  transport.close();
});

it("preserves stricter configured timeouts", () => {
  const transport = nodemailer.createTransport(boundedSmtpUrl("smtp://smtp.example.test?socketTimeout=2000"));
  expect(transport.options).toMatchObject({ socketTimeout: 2000 });
  transport.close();
});
