# Coldbrew

*Approval-first outreach for local businesses.* An open-source app that runs on your own computer. It builds a ranked list
of businesses in a city, helps you write a short honest first message to each one, holds every draft until you approve it,
reads the replies back, and shows what works. **It never sends anything itself.**

Status: early. The engine, drafting and approval rules, reply handling and the API are built and tested; the interface is next.

See [docs/PLAN.md](docs/PLAN.md) for what it does and why. Successor to [anydeals](https://github.com/ahmedmetered/anydeals).

```bash
npm install     # only for reading replies over IMAP (imapflow, mailparser)
npm test        # no network
npm start       # http://localhost:7679
```

MIT licensed. Prospect data is personal data in many countries: you are responsible for lawful use, lists are for your
own outreach and not for resale, and none of this is legal advice.
