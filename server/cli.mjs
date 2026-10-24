import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query, pool, migrate, audit } from './db.mjs';
import { passwordHash, token, validId } from './security.mjs';
import {acquireImportAdmission,checkImportCapacity} from './import-admission.mjs';
import {readPublication} from './publication-files.mjs';
import {checkedPublicationView} from './publication-model.mjs';
import {assertUploadRetryable} from './upload-lifecycle.mjs';
import {applyImportDecision,canRetryImport} from './import-decisions.mjs';
import {createDiscoveryRequest,getDiscoveryRequest,listDiscoveryRequests,decideDiscoveryRequest} from './discovery-requests.mjs';
import {resolveRanobe} from './ranobe.mjs';
import {createRanobeRequest,listRanobeFeeds,getRanobeFeed,getRanobeRun,getRanobeParts,configureRanobeFeed} from './ranobe-store.mjs';
import {requestDerived,derivedProfiles} from './derived-orchestrator.mjs';
import {listDerivedRequests,getDerivedRequest,decideDerivedRequest,getDerivedResult} from './derived-jobs.mjs';
await migrate();
const args=process.argv.slice(2),[group,action,id,role]=args;
const help=`Cotology — локальная консоль библиотеки

  help                                  Эта справка и примеры
  bootstrap                             Создать владельца; пароль выводится ОДИН раз
  profiles list                         Профили и ID
  profiles create <login>                Новый читатель; пароль выводится один раз
  profiles reset <profile-id>            Сбросить пароль и все сессии профиля
  roles list                            owner, reader, trusted-import
  roles grant <profile-id> trusted-import Автоодобрение своих импортов и поисковых заявок
  roles revoke <profile-id> trusted-import Отозвать автоодобрение
  requests list                         Последние заявки и ошибки
  requests approve <request-id>          Одобрить прямой файл или ветку RanobeLib
  requests reject <request-id>           Отклонить ожидающую заявку
  requests retry <request-id>            Повторить ВСЕ проверки после ошибки или исправления адаптера RanobeLib
  requests cancel <request-id>           Отменить ожидающую/активную задачу без удаления готовой книги
  discovery request "название"           Поиск и безопасный импорт; язык ru, аудио ожидает TTS
     --language en --allow-original --no-audio --intent book|author|series
     --key <UUID>                        Повторить запрос с тем же ключом без дублирования
  discovery list                        Поисковые заявки и отдельные статусы книги/перевода/аудио
  discovery show <request-id>            Результаты, уточнения, revision и plan_revision
  discovery approve <request-id> <revision> Одобрить запрос читателя
  discovery cancel <request-id> <revision> Отменить поиск и незавершённый импорт
  discovery retry <request-id> <revision> Повторить поиск после ошибки
  discovery more <request-id> <revision> Следующая сохранённая страница автора/серии
  discovery refine <request-id> <revision> "уточнение"
     --intent book|author|series --language ru --allow-original --no-audio
                                        Уточнить поиск без обхода одобрения и проверок
  discovery select <request-id> <candidate-id> <plan_revision> <revision>
                                        Выбрать результат из сохранённого плана
  ranobe preview <url>                   Оглавление, доступные ветки и их ID
  ranobe full <url> --branch default|<ID> Полностью получить выбранную ветку
     --language ru --no-updates --force --key <UUID>
  ranobe list                           Логические книги и подписки на новые главы
  ranobe show <feed-id>                  Текущая версия и упорядоченные части
  ranobe refresh <feed-id> [--force]     Проверить новые главы; force повторно сверяет все
  ranobe updates <feed-id> on|off        Включить/отключить проверку новых глав
  storage status                        Сводка целостности, очереди и очистки
  storage journal                       Объём журнала и автоматическое уплотнение
  derived profiles                      Закреплённые локальные модели и ограничения
  derived request <book-id> --translate  EN→RU, отдельный машинный черновик + аудио
     --source-language en --no-audio --key <UUID>
  derived request <book-id> --audio      Озвучивание русского оригинала без перевода
     --source-language ru
  derived request --snapshot <run-id> --translate|--audio
                                        Все части выбранной версии новеллы по порядку
  derived list                          Заявки, сохранённый прогресс и причины пауз
  derived show <request-id>              Подробности отдельной заявки
  derived approve|cancel|retry <request-id> <revision>
                                        Одобрить, отменить свою заявку или повторить ошибку
  derived result <job-id>                Публикации перевода или аудиоманифест
  storage verify                        Проверить хеши всех разрешённых книг (без изменения файлов)
  security status                       Паузы и состояние сканера
  security pause                        Остановить новые/активные импорты
  security resume                       Возобновить очередь
  security lockdown                     Остановить импорт И выдачу книг
  security unlock                       Разрешить выдачу, импорт остаётся на паузе
  security block <book-id>               Заблокировать книгу и связанные копии по хешу
  security recipients <book-id>          Кому сервер выдавал локальный пакет
  security purge <request-id>           Удалить карантин неактивной задачи, оставить отчёт
  audit list                            Последние события

Примеры: node server/cli.mjs profiles list
         node server/cli.mjs roles grant <ID-из-списка> trusted-import
         node server/cli.mjs security lockdown
         node server/cli.mjs storage journal
         node server/cli.mjs discovery request "серия книг Коты-воители" --intent series
         node server/cli.mjs discovery request "все книги автора Артура Кларка" --allow-original
         node server/cli.mjs discovery refine <ID-заявки> <revision> "Свидание с Рамой автора Артура Кларка" --allow-original
         node server/cli.mjs ranobe preview https://ranobelib.me/ru/book/<ID--slug>
         node server/cli.mjs ranobe full https://ranobelib.me/ru/book/<ID--slug> --branch default
Любая команда с --help показывает эту локальную справку.
Безопасность нельзя отключить ролью или одобрением.
Команды выполняются через scripts/library.ps1, например:
  ./scripts/library.ps1 help
`;
try{
  if(!group||group==='help'||args.includes('--help'))console.log(help);
  else if(group==='bootstrap'||group==='profiles'&&['create','reset'].includes(action)){
    const password=token().slice(0,24);
    if(group==='profiles'&&action==='reset'){
      await query('UPDATE profiles SET password=$1 WHERE id=$2',[await passwordHash(password),validId(id)]);await query('DELETE FROM sessions WHERE profile_id=$1',[id]);
      console.log(JSON.stringify({profile:id,password}));
    }else{
      const login=group==='bootstrap'?'owner':id;
      if(!/^[a-zA-Z0-9_-]{3,40}$/.test(login||''))throw new Error('Логин: 3–40 латинских букв, цифр, _ или -');
      if(group==='bootstrap'&&Number((await query('SELECT count(*) FROM profiles')).rows[0].count)>0)throw new Error('Bootstrap уже выполнен');
      const profileId=randomUUID();await query('INSERT INTO profiles(id,login,password,role) VALUES($1,$2,$3,$4)',[profileId,login,await passwordHash(password),group==='bootstrap'?'owner':'reader']);
      console.log(JSON.stringify({login,password,id:profileId}));
    }
  }else if(group==='profiles'&&action==='list')console.table((await query('SELECT id,login,role FROM profiles')).rows);
  else if(group==='derived'){
    const actor=(await query("SELECT id,role FROM profiles WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];if(!actor)throw new Error('Сначала создайте владельца');let result;
    if(action==='profiles')result=await derivedProfiles();
    else if(action==='list')result=await listDerivedRequests(pool,actor);
    else if(action==='show')result=await getDerivedRequest(pool,actor,validId(id));
    else if(action==='result')result=await getDerivedResult(pool,actor,validId(id));
    else if(['approve','cancel','retry'].includes(action))result=await decideDerivedRequest(pool,actor,{id:validId(id),action,expectedRevision:Number(role)});
    else if(action==='request'){
      const input={idempotencyKey:randomUUID(),kind:'translation',audio:true},tail=args.slice(2);let bookId=null;
      for(let n=0;n<tail.length;n++){const flag=tail[n];if(flag==='--translate')input.kind='translation';else if(flag==='--audio'){input.kind='audio';input.audio=false;}else if(flag==='--no-audio')input.audio=false;else if(['--source-language','--key','--snapshot'].includes(flag)){const value=tail[++n];if(!value)throw new Error('Нужно значение '+flag);input[flag==='--key'?'idempotencyKey':flag==='--snapshot'?'snapshotId':'sourceLanguage']=value;}else if(!flag.startsWith('--')&&!bookId)bookId=validId(flag);else throw new Error('Неизвестный параметр '+flag);}
      if(input.snapshotId){if(bookId)throw new Error('Укажите книгу или полную версию новеллы');input.publicationIds=(await getRanobeParts(pool,validId(input.snapshotId))).map(row=>row.book_id);}
      else input.publicationIds=[validId(bookId)];
      result=await requestDerived(pool,actor,input,{library:process.env.LIBRARY_DIR||'/library'});
    }else throw new Error('Используйте help для команд derived');
    console.log(JSON.stringify(result,null,2));
  }
  else if(group==='ranobe'){
    const actor=(await query("SELECT id,role FROM profiles WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];if(!actor)throw new Error('Сначала создайте владельца');let result;
    if(action==='preview'){const info=await resolveRanobe(id);result={...info,list:undefined,inventory:undefined};}
    else if(action==='list')result=await listRanobeFeeds(pool);
    else if(action==='show'){const feed=await getRanobeFeed(pool,validId(id));if(!feed)throw new Error('Книга не найдена');result={feed,version:feed.head_run_id?await getRanobeRun(pool,feed.head_run_id):null,parts:feed.head_run_id?await getRanobeParts(pool,feed.head_run_id):[]};}
    else if(action==='updates'){const feed=await getRanobeFeed(pool,validId(id));if(!feed||!['on','off'].includes(role))throw new Error('Нужно: ranobe updates <feed-id> on|off');result=await configureRanobeFeed(pool,actor,id,{autoUpdate:role==='on',expectedRevision:feed.revision});}
    else if(['full','refresh'].includes(action)){
      let input={url:id,idempotencyKey:randomUUID()};const tail=args.slice(3);
      if(action==='refresh'){const feed=await getRanobeFeed(pool,validId(id));if(!feed)throw new Error('Книга не найдена');input={...input,url:`https://ranobelib.me/ru/book/${feed.slug}`,branch:feed.branch_key==='default'?null:feed.branch_key,language:feed.language,autoUpdate:feed.auto_update};}
      for(let n=0;n<tail.length;n++){const flag=tail[n];if(flag==='--force')input.force=true;else if(flag==='--no-updates')input.autoUpdate=false;else if(['--branch','--language','--key'].includes(flag)){const value=tail[++n];if(!value)throw new Error('Нужно значение '+flag);input[flag==='--key'?'idempotencyKey':flag.slice(2)]=flag==='--branch'&&value==='default'?null:value;}else throw new Error('Неизвестный параметр '+flag);}
      const release=await acquireImportAdmission(pool);try{result=await createRanobeRequest(pool,actor,input,{checkCapacity:client=>checkImportCapacity(client,process.env.QUARANTINE_DIR||'/quarantine',process.env.LIBRARY_DIR||'/library')});}finally{await release();}
    }else throw new Error('Используйте help для команд RanobeLib');console.log(JSON.stringify(result,null,2));
  }
  else if(group==='discovery'){
    const owner=(await query("SELECT id FROM profiles WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];if(!owner)throw new Error('Сначала создайте владельца');
    let result;
    if(action==='request'){
      const options={query:id,idempotencyKey:randomUUID()},tail=args.slice(3);
      for(let n=0;n<tail.length;n++){const flag=tail[n];if(flag==='--allow-original')options.allowOriginal=true;else if(flag==='--no-audio')options.audio=false;else if(['--language','--intent','--key'].includes(flag)){const value=tail[++n];if(!value)throw new Error('Нужно значение '+flag);options[flag==='--key'?'idempotencyKey':flag.slice(2)]=value;}else throw new Error('Неизвестный параметр '+flag);}
      result=await createDiscoveryRequest(pool,owner,options);
    }else if(action==='list')result=await listDiscoveryRequests(pool,owner);
    else if(action==='show')result=await getDiscoveryRequest(pool,owner,validId(id));
    else if(['approve','cancel','retry','more'].includes(action))result=await decideDiscoveryRequest(pool,owner,{id:validId(id),action,expectedRevision:Number(role)});
    else if(action==='refine'){
      const options={id:validId(id),action,expectedRevision:Number(role),query:args[4]},tail=args.slice(5);
      for(let n=0;n<tail.length;n++){const flag=tail[n];if(flag==='--allow-original')options.allowOriginal=true;else if(flag==='--no-audio')options.audio=false;else if(['--language','--intent'].includes(flag)){const value=tail[++n];if(!value)throw new Error('Нужно значение '+flag);options[flag.slice(2)]=value;}else throw new Error('Неизвестный параметр '+flag);}
      result=await decideDiscoveryRequest(pool,owner,options);
    }
    else if(action==='select')result=await decideDiscoveryRequest(pool,owner,{id:validId(id),action,candidateId:role,planRevision:Number(args[4]),expectedRevision:Number(args[5])});
    else throw new Error('Используйте help для команд поиска');
    console.log(JSON.stringify(result,null,2));
  }
  else if(group==='roles'&&action==='list')console.log('owner — владелец\nreader — чтение и заявки\ntrusted-import — чтение и автоодобрение собственных файлов, прямых ссылок, веток RanobeLib и поисковых заявок');
  else if(group==='roles'&&['grant','revoke'].includes(action)){
    if(role!=='trusted-import')throw new Error('В первой версии назначается только trusted-import; владелец защищён');
    const result=await query("UPDATE profiles SET role=$1 WHERE id=$2 AND role<>'owner' RETURNING id,login,role",[action==='grant'?'trusted-import':'reader',validId(id)]);
    if(!result.rowCount)throw new Error('Профиль не найден или это владелец');
    if(action==='revoke')await query("UPDATE imports SET status='pending-approval',approved_by=NULL,decision_reason=NULL WHERE requested_by=$1 AND status='queued' AND decision_reason='role-auto-approval'",[id]);
    await audit(null,`role.${action}`,id,{role});console.table(result.rows);
  }else if(group==='requests'&&action==='list')console.table((await query('SELECT id,kind,filename,status,stage,error FROM imports ORDER BY created_at DESC LIMIT 30')).rows);
  else if(group==='requests'&&['approve','reject','retry','cancel'].includes(action)){
    const release=await acquireImportAdmission(pool);try{
    validId(id);const row=(await query('SELECT * FROM imports WHERE id=$1',[id])).rows[0];if(!row)throw new Error('Заявка не найдена');
    const owner=(await query("SELECT id FROM profiles WHERE role='owner' ORDER BY created_at,id LIMIT 1")).rows[0];if(!owner)throw new Error('Сначала создайте владельца');
    if(action==='approve'&&(!['file','ranobe'].includes(row.kind)||row.status!=='pending-approval'))throw new Error('Для неизвестного сайта нужен адаптер/прямой файл. Одобрение не включает универсальный парсер');
    if(action==='retry'&&!canRetryImport(row))throw new Error('Повтор после ошибки/блокировки или для проверки поддерживаемой полной ветки RanobeLib');
    if(action==='retry')await assertUploadRetryable(row,process.env.QUARANTINE_DIR||'/quarantine');
    if(row.status==='completed'||row.status==='processing'&&action!=='cancel')throw new Error('Нельзя менять эту активную/завершённую заявку');
    if(['approve','retry'].includes(action))await checkImportCapacity(pool,process.env.QUARANTINE_DIR||'/quarantine',process.env.LIBRARY_DIR||'/library',{exclude:id});
    await applyImportDecision(pool,{id,expectedStatus:row.status,action,actor:owner.id,reason:['approve','retry'].includes(action)?'console-owner-approval':`console-owner-${action}`});console.log('Готово');
    }finally{await release();}
  }else if(group==='storage'&&action==='status'){
    console.log(JSON.stringify({books:(await query("SELECT count(*)::int AS total,count(*) FILTER(WHERE artifact_manifest IS NOT NULL)::int AS sealed,count(*) FILTER(WHERE security_state<>'passed')::int AS blocked FROM books")).rows[0],imports:(await query("SELECT count(*) FILTER(WHERE cleanup_pending)::int AS cleanupPending,count(*) FILTER(WHERE cleanup_error IS NOT NULL)::int AS cleanupErrors,count(*) FILTER(WHERE status='processing' AND lease_expires_at<now())::int AS expired FROM imports")).rows[0]}));
  }else if(group==='storage'&&action==='journal'){
    const budget=(await query('SELECT rows,bytes FROM reader_journal_budget WHERE singleton')).rows[0];
    if(!budget)throw new Error('Сводка журнала недоступна');
    console.log(JSON.stringify({rows:Number(budget.rows),bytes:Number(budget.bytes),maxRows:250000,maxBytes:96*1024*1024,protocolVersions:[1,2],retention:'V2 accepted receipts compact automatically; conflicts and tombstones are preserved'}));
  }else if(group==='storage'&&action==='verify'){
    let verified=0;for(const book of (await query("SELECT * FROM books WHERE security_state='passed' ORDER BY id")).rows){const checked=await readPublication(process.env.LIBRARY_DIR||'/library',book);checkedPublicationView(book,checked.content);verified++;}
    console.log(JSON.stringify({ok:true,verified,scope:'Exact prepared bytes/hashes; not a new antivirus scan'}));
  }else if(group==='security'&&action==='status'){
    console.table((await query('SELECT * FROM settings')).rows);console.table((await query('SELECT * FROM system_status')).rows);
  }else if(group==='security'&&['pause','resume','lockdown','unlock'].includes(action)){
    const sql={pause:'imports_paused=true',resume:'imports_paused=false',lockdown:'imports_paused=true,serving_paused=true',unlock:'serving_paused=false'}[action];
    await query(`UPDATE settings SET ${sql} WHERE id=1`);await audit(null,`security.${action}`,'system');console.table((await query('SELECT * FROM settings')).rows);
  }else if(group==='security'&&action==='block'){
    const row=(await query('SELECT sha256 FROM books WHERE id=$1',[validId(id)])).rows[0];if(!row)throw new Error('Книга не найдена');
    const result=await query("UPDATE books SET security_state='blocked',blocked_reason='Блокировка владельцем: подозрение на угрозу' WHERE sha256=$1 RETURNING id,title",[row.sha256]);
    await audit(null,'security.book-blocked',id,{affected:result.rows.map(x=>x.id)});console.table(result.rows);
  }else if(group==='security'&&action==='recipients'){
    console.table((await query("SELECT a.created_at,p.login,a.target FROM audit a JOIN profiles p ON p.id=a.actor WHERE a.action='book.package.issued' AND a.target=$1 ORDER BY a.created_at",[validId(id)])).rows);
  }else if(group==='security'&&action==='purge'){
    const release=await acquireImportAdmission(pool);try{
    const row=(await query('SELECT status FROM imports WHERE id=$1',[validId(id)])).rows[0];if(!row||!['blocked','error','rejected','cancelled'].includes(row.status))throw new Error('Удаление доступно только неактивному карантину');
    await fs.unlink(path.join(process.env.QUARANTINE_DIR||'/quarantine','incoming',id)).catch(e=>{if(e.code!=='ENOENT')throw e;});await audit(null,'quarantine.purged',id);console.log('Файл удалён; отчёт сохранён');
    }finally{await release();}
  }else if(group==='audit'&&action==='list')console.table((await query('SELECT * FROM audit ORDER BY id DESC LIMIT 40')).rows);
  else throw new Error('Неизвестная команда. Используйте help');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await pool.end();}
