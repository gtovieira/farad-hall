// E-mail behind an interface: SMTP in production, a log line when no SMTP server is set, a memory
// box in tests.
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail {
  to: string[];
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Writes each mail to the log instead of sending it. */
export class LogMailer implements Mailer {
  constructor(private readonly log: (msg: string, data: object) => void) {}
  async send(mail: Mail): Promise<void> {
    this.log('mail (log transport: not sent)', { to: mail.to, subject: mail.subject });
  }
}

/** Keeps the mails (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  failNext = false;
  async send(mail: Mail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('SMTP refused');
    }
    this.sent.push(mail);
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: nodemailer.Transporter;
  constructor(
    cfg: { host: string; port: number; secure: boolean; user: string | undefined; password: string | undefined },
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.password ?? '' } } : {}),
    });
  }
  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to.join(', '), subject: mail.subject, text: mail.text });
  }
}

export function mailerFor(config: Config, log: (msg: string, data: object) => void): Mailer {
  const m = config.mail;
  return m.transport === 'smtp' ? new SmtpMailer(m, m.from) : new LogMailer(log);
}
