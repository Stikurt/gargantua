import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
let derivations=0;
async function deriveBounded(password,salt){
  if(derivations>=2)throw Object.assign(new Error('Проверяется другой вход. Повторите через несколько секунд'),{status:429});
  derivations++;
  try{return await derive(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});}finally{derivations--;}
}
export const hash = data => createHash('sha256').update(data).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validId(value) { if (!uuidPattern.test(value || '')) throw Object.assign(new Error('Некорректный ID'), { status: 400 }); return value; }
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Пароль: от 12 до 256 символов');
  const salt = token();
  const key = await deriveBounded(password,salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, hex] = stored.split('$');
  if (algorithm !== 'scrypt') return false;
  const key = await deriveBounded(password,salt);
  return timingSafeEqual(key, Buffer.from(hex, 'hex'));
}
export function safeName(value) { return String(value || 'book').replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 180); }
export function fileType(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (!['txt','fb2','epub'].includes(ext)) throw Object.assign(new Error('Пока поддерживаются EPUB, FB2 и TXT'), {status: 400});
  return ext;
}
