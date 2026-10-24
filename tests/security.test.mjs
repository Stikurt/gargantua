import test from 'node:test';
import assert from 'node:assert/strict';
import {passwordHash,verifyPassword,fileType,validId}from'../server/security.mjs';
import{checkUrl,publicAddress}from'../server/fetch.mjs';
test('passwords: salted scrypt and verification',async()=>{const pass='a-long-test-password';const h=await passwordHash(pass);assert.ok(await verifyPassword(pass,h));assert.equal(await verifyPassword('wrong',h),false);assert.notEqual(h,await passwordHash(pass));});
test('SSRF: private, mapped, loopback, link-local and reserved ranges rejected',()=>{for(const ip of['127.0.0.1','10.0.0.1','192.168.1.5','172.16.0.1','169.254.169.254','0.0.0.0','::1','fc00::1','fe80::1','::ffff:127.0.0.1','224.0.0.1'])assert.equal(publicAddress(ip),false,ip);assert.ok(publicAddress('1.1.1.1'));});
test('URL policy excludes other protocols, credentials, ports and fragments',()=>{for(const url of['http://example.com/file.epub','file:///etc/passwd','https://user:pass@example.com/a','https://example.com:444/a','https://example.com/a#x'])assert.throws(()=>checkUrl(url));assert.equal(checkUrl('https://example.com/a').protocol,'https:');});
test('supported formats and IDs are allowlisted',()=>{assert.equal(fileType('Книга.EPUB'),'epub');for(const value of['x.exe','x.pdf','x.zip','x.cbz'])assert.throws(()=>fileType(value));assert.throws(()=>validId('../../etc/passwd'));});
