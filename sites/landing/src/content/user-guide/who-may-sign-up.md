---
title: 'Restrict Who Can Sign Up to Your Stubbase API by Email Domain — User Guide'
description: 'Accept only your company domain, block particular domains, or refuse throwaway email providers at sign-up on your Stubbase API, with an exception list for the addresses you want through.'
h1: 'Choose who may sign up'
subheadline: 'Anyone with a working email address can open an account on your API until you say otherwise. Four lines decide who may.'
label: 'Who may sign up'
chapter: 'auth'
order: 5
publishedAt: 2026-10-11
hero:
  src: /user-guide/who-may-sign-up/hero.png
  alt: 'The Live tab sending a sign-up from a gmail.com address and a 403 response: that email domain is not accepted for sign-up on this API'
  caption: 'With AUTH_EMAIL_DOMAINS_ONLY=example.com deployed, other domains are refused with a 403.'
---

## Where the rules apply

These lines apply to password sign-up and to Google and GitHub sign-in alike,
and **only when an account would be created**. Someone who already has an
account keeps signing in, whatever their address, so a rule you add later never
locks out a user you have already accepted. All four need `AUTH_ENABLED=true`.

## Accept only your own domain

```bash
AUTH_EMAIL_DOMAINS_ONLY=your-company.com
```

Every other address is refused with a `403`. Good for an internal tool or a
staging project. List several, comma-separated with no spaces. A domain covers
its subdomains, so `your-company.com` also accepts `ada@mail.your-company.com`.

## Refuse particular domains

```bash
AUTH_EMAIL_DOMAINS_BLOCKED=rival.com,spam-source.test
```

Everyone else is still welcome. Subdomains go with the domain.

## Refuse throwaway addresses

```bash
AUTH_BLOCK_DISPOSABLE_EMAIL=true
```

Refuses mailinator, guerrillamail, 10minutemail and around 75,000 other
throwaway providers. It is off unless you switch it on, because a demo or a
workshop is a perfectly good reason to let people use one.

## Let a domain through anyway

```bash
AUTH_EMAIL_DOMAINS_ALLOWED=partner.com
```

An exception, not a gate: it beats the blocked list and the throwaway list, and
on its own it accepts nobody new. Use it when the throwaway list, which is a
community one, catches a provider your users really use.

## How they combine

| You set | A sign-up from | Is |
|---|---|---|
| nothing | anywhere | accepted |
| `AUTH_EMAIL_DOMAINS_ONLY=acme.com` | `ada@acme.com` | accepted |
| `AUTH_EMAIL_DOMAINS_ONLY=acme.com` | `ada@gmail.com` | refused |
| `AUTH_BLOCK_DISPOSABLE_EMAIL=true` | `ada@mailinator.com` | refused |
| `AUTH_BLOCK_DISPOSABLE_EMAIL=true` and `AUTH_EMAIL_DOMAINS_ALLOWED=mailinator.com` | `ada@mailinator.com` | accepted |
