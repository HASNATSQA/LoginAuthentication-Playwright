import {test, expect, Page} from '@playwright/test';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const SAFE_TIMEOUT_MS = 90_000;
const SMS_POLL_INTERVAL_MS = 2500;
const MIN_AGE_MS = 1000;
const MAX_AGE_MS = 30000;

function getMessageField(msg: any, fields: string[]): string {
  for(const field of fields) {
    if(msg[field]) return String(msg[field])
  }
return '';
}

function getMessageFrom(msg: any): string {
  return getMessageField(msg, ['from', 'sender', 'phoneNumber', 'number']).replace(/\D/g, '');
}


function getMessageText(msg: any): string {
  return getMessageField(msg, ['test', 'body', 'message', 'content'])
}

function getMessageId(msg: any): string {
  return msg.id || msg.messageId || msg._id || JSON.stringify(msg);
}

function getMessageTimeStamp(msg: any): number | null {
  if(typeof msg.timestamp === 'number') return msg.timestamp;

  const candidates = ['timestamp', 'createdAt', 'updatedAt', '@timestamp', 'date', 'receivedAt', 'sentAt'];
  for(const c of candidates) {
    if(msg(c)) {
      if(typeof msg[c] === 'number') return msg[c];
      const ts = Date.parse(msg[c]);
      if(!Number.isNaN(ts)) return ts
    }
  }
  return null;
}

function extract6DigitOtpFromText(text: string | null): string | null {
  if(!text) return null;

  const dnFormatMatch = text.match(/\((\d{6})\)\s*is\s*your\s*DN\s*verification\s*code/i);
  if(dnFormatMatch) return dnFormatMatch[1];

  const normalized = text.replace(/[\u00A0]/g, ' ').replace(/[^0-9]/g, ' ');
  return normalized.match(/\b(\d{6})\b/)?.[1] || normalized.match(/(\d{6})/)?.[1] || null;
}

function getOtpFromMessage(msg: any): string | null {
  return msg.code || extract6DigitOtpFromText(getMessageText(msg));
}


class ReceiveSmsApiClient {
  private apiUrl: string;
  public senderPhoneNumber: string;

  constructor(receiveSmsUrl: string, senderPhoneNumber: string) {
    this.apiUrl = receiveSmsUrl.replace(/\/$/, '');
    this.senderPhoneNumber = senderPhoneNumber;
  }
}

