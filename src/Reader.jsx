import React,{useState,useEffect,useLayoutEffect,useMemo,useRef} from 'react';
import {serialReaderModel,serialReaderTarget,createSerialReaderNavigator} from './serial-reader.mjs';

const shelves={reading:'Читаю',planned:'В планах',finished:'Прочитано',paused:'Отложено',dropped:'Брошено',favorite:'Любимое'};
function Icon({name,size=20}){
 const paths={bookmark:'M6 3h12v18l-6-4-6 4z',arrow:'M14 5l-7 7 7 7',menu:'M4 6h16 M4 12h16 M4 18h16'};
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
export default function Reader({data,me,online,onBack,onPosition,onMark,notify=()=>{},onOpenPart,api}){
 const initialIndex=Number.isSafeInteger(data.index)&&data.index>=0&&data.index<data.chapters.length?data.index:0;
 const [index,setIndex]=useState(initialIndex),[chapter,setChapter]=useState(null),[font,setFont]=useState(Number(localStorage.getItem('font')||21)),[theme,setTheme]=useState(localStorage.getItem('theme')||(getComputedStyle(document.documentElement).colorScheme==='dark'?'dark':'paper')),[menu,setMenu]=useState(false),[loading,setLoading]=useState(false),[readerFont,setReaderFont]=useState(localStorage.getItem('readerFont')||'serif'),[spacing,setSpacing]=useState(localStorage.getItem('readerSpacing')||'1.8'),[navigating,setNavigating]=useState(false),[saveStatus,setSaveStatus]=useState('Сохранено на устройстве');
 const pane=useRef(),position=useRef(Number.isFinite(data.position)&&data.position>=0&&data.position<=1?data.position:0),saveTimer=useRef(null),pendingPosition=useRef(null),saveCallback=useRef(onPosition),writes=useRef(Promise.resolve()),restoring=useRef(true),mounted=useRef(true),flushRef=useRef(),openPartRef=useRef(onOpenPart),withinNavigation=useRef(false),navigator=useRef();
 saveCallback.current=onPosition;openPartRef.current=onOpenPart;
 const context=useMemo(()=>{try{return {model:serialReaderModel(data,index)};}catch(error){return {model:serialReaderModel({...data,serialGroup:null,serialBookmarks:null},index),error};}},[data,index]);
 const model=context.model;
 useEffect(()=>{if(context.error)notify('Общее оглавление недоступно. Сохранённая часть открыта отдельно.');},[context.error?.code]);
 function persistPosition(value){
  if(mounted.current)setSaveStatus('Сохраняем…');
  const next=writes.current.catch(()=>{}).then(()=>saveCallback.current(value.book,value.chapter,value.position,value.shelf)).then(()=>{if(mounted.current)setSaveStatus('Сохранено на устройстве');}).catch(error=>{if(!pendingPosition.current)pendingPosition.current=value;if(mounted.current)setSaveStatus('Не сохранено — повторите');notify('Не удалось сохранить позицию чтения: '+error.message);throw error;});
  writes.current=next;next.catch(()=>{});return next;
 }
 function flushPosition(){clearTimeout(saveTimer.current);const value=pendingPosition.current;pendingPosition.current=null;return value?persistPosition(value):writes.current;}
 flushRef.current=flushPosition;
 function newNavigator(){return createSerialReaderNavigator({flush:()=>flushRef.current(),openPart:(...args)=>{if(typeof openPartRef.current!=='function')throw Error('Переход между частями пока недоступен. Откройте книгу из библиотеки.');return openPartRef.current(...args);},onBusy:value=>{if(mounted.current)setNavigating(value);}});}
 if(!navigator.current)navigator.current=newNavigator();
 function schedulePosition(){pendingPosition.current={book:data.book,chapter:index,position:position.current};setSaveStatus('Сохраняем…');clearTimeout(saveTimer.current);saveTimer.current=setTimeout(()=>flushPosition().catch(()=>{}),600);}
 useEffect(()=>{
  mounted.current=true;if(!navigator.current)navigator.current=newNavigator();const hidden=()=>{if(document.visibilityState==='hidden')flushPosition().catch(()=>{});},close=event=>{navigator.current?.invalidate();event.detail?.waitUntil?.(flushPosition());};
  window.addEventListener('cotology-before-close',close);document.addEventListener('visibilitychange',hidden);
  return()=>{mounted.current=false;navigator.current?.dispose();navigator.current=null;window.removeEventListener('cotology-before-close',close);document.removeEventListener('visibilitychange',hidden);flushPosition().catch(()=>{});};
 },[]);
 useEffect(()=>{
  let active=true;restoring.current=true;setLoading(true);
  (async()=>{try{
   let content;if(data.localOnly)content=data.downloaded?.content.chapters[index];else try{if(typeof api!=='function')throw Error('Соединение с сервером недоступно');content=await api(`/books/${data.book.id}/chapters/${index}`);}catch(error){if(error.status&&error.status!==401)throw error;content=data.downloaded?.content.chapters[index];}
   if(!content)throw Error('Глава не сохранена. Подключитесь к серверу.');if(active)setChapter(content);
  }catch(error){if(active){setChapter(null);notify(error.message);}}finally{if(active)setLoading(false);}})();return()=>{active=false;};
 },[index,data.book.id,data.localOnly]);
 useLayoutEffect(()=>{if(!loading&&chapter&&pane.current){const element=pane.current;element.scrollTop=position.current*Math.max(0,element.scrollHeight-element.clientHeight);restoring.current=false;}},[chapter,loading]);
 async function go(globalIndex,pos=0){
  try{
   const target=serialReaderTarget(model,globalIndex,pos);if(withinNavigation.current||navigator.current.isBusy())return;
   if(target.publicationId!==data.book.id){await navigator.current.open(target);return;}
   withinNavigation.current=true;await flushPosition();await persistPosition({book:data.book,chapter:target.index,position:target.position});if(!mounted.current)return;
   position.current=target.position;if(target.index===index){const element=pane.current;if(element)element.scrollTop=target.position*(element.scrollHeight-element.clientHeight);}else setIndex(target.index);setMenu(false);
  }catch(error){if(mounted.current)notify(error.message);}finally{withinNavigation.current=false;}
 }
 async function back(){navigator.current.invalidate();pendingPosition.current={book:data.book,chapter:index,position:position.current};try{await flushPosition();if(mounted.current)onBack();}catch{}}
 const asset=key=>data.downloaded?.content.assets?.[key]?`data:image/png;base64,${data.downloaded.content.assets[key]}`:`/api/books/${data.book.id}/assets/${key}`;
 return <div className={`reader theme-${theme}`}><header className="reader-toolbar">
  <button data-testid="reader-return-library" onClick={back}><Icon name="arrow"/>Библиотека</button>
  <div><strong>{model.title}</strong><small>{model.author}</small></div>
  <div className="reader-tools"><button aria-label="Оглавление и закладки" onClick={()=>setMenu(!menu)}><Icon name="menu"/></button>
   <button title="Уменьшить шрифт" onClick={()=>{const value=Math.max(15,font-1);setFont(value);localStorage.setItem('font',value);}}>A−</button>
   <button title="Увеличить шрифт" onClick={()=>{const value=Math.min(32,font+1);setFont(value);localStorage.setItem('font',value);}}>A+</button>
   <button title="Сменить тему" onClick={()=>{const value=theme==='paper'?'dark':theme==='dark'?'sepia':'paper';setTheme(value);localStorage.setItem('theme',value);}}>◐</button>
   <button data-testid="reader-add-bookmark" aria-label="Добавить закладку" disabled={navigating} onClick={()=>{const note=prompt('Название закладки (необязательно)','');if(note!==null)onMark(data.book,index,position.current,note).catch(error=>notify(error.message));}}><Icon name="bookmark"/></button>
  </div></header>
  {menu&&<aside className="reader-menu"><h3>Оглавление</h3>{model.toc.map(item=><button data-testid={`reader-toc-${item.globalIndex}`} key={`${item.publicationId||'pending'}:${item.globalIndex}`} className={item.globalIndex===model.globalIndex?'active':''} disabled={!item.available||navigating} title={item.available?undefined:'Эта глава ещё не сохранена или недоступна'} onClick={()=>go(item.globalIndex)}>{item.globalIndex+1}. {item.title}</button>)}
   <h3>Закладки</h3>{model.bookmarks.length?model.bookmarks.map(mark=><button key={`${mark.publicationId}:${mark.id}`} disabled={!mark.available||navigating} onClick={()=>go(mark.globalIndex,mark.position)}><Icon name="bookmark" size={14}/> {mark.note||`Глава ${mark.globalIndex+1}`}</button>):<p className="small muted">Закладок пока нет.</p>}
   <h3>Вид текста</h3><label>Шрифт<select value={readerFont} onChange={event=>{setReaderFont(event.target.value);localStorage.setItem('readerFont',event.target.value);}}><option value="serif">Книжный</option><option value="sans-serif">Без засечек</option><option value="monospace">Моноширинный</option></select></label>
   <label>Межстрочный интервал<select value={spacing} onChange={event=>{setSpacing(event.target.value);localStorage.setItem('readerSpacing',event.target.value);}}><option value="1.5">Компактный</option><option value="1.8">Обычный</option><option value="2.1">Свободный</option></select></label>
   <h3>Полка</h3><select aria-label="Статус чтения" disabled={navigating} defaultValue={data.book.shelf||'reading'} onChange={event=>{data.book.shelf=event.target.value;persistPosition({book:data.book,chapter:index,position:position.current,shelf:event.target.value}).catch(()=>{});}}>{Object.entries(shelves).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select>
  </aside>}
  <div className="reader-scroll" ref={pane} onScroll={()=>{if(restoring.current)return;const element=pane.current;position.current=element.scrollHeight>element.clientHeight?element.scrollTop/(element.scrollHeight-element.clientHeight):0;schedulePosition();}}>
   <article className="reading-page" style={{fontSize:font,fontFamily:readerFont,lineHeight:spacing}}><span className="eyebrow">ГЛАВА {model.globalIndex+1} ИЗ {model.totalChapters}</span><h1>{chapter?.title||'Открываем главу…'}</h1><div className="chapter-rule">✦</div>
    {loading?<p className="muted">Загрузка…</p>:chapter?.blocks.map((block,i)=>block.type==='image'?<figure key={i}><img src={asset(block.asset)} alt={block.text||'Иллюстрация'} loading="lazy"/>{block.text&&<figcaption>{block.text}</figcaption>}</figure>:block.type==='heading'?<h2 key={i}>{block.text}</h2>:<p key={i}>{block.text}</p>)}
    {!loading&&chapter&&<div className="chapter-end">✦</div>}<div className="chapter-nav"><button data-testid="reader-previous-chapter" disabled={!model.previous?.available||navigating} onClick={()=>go(model.globalIndex-1)}>← Предыдущая</button><button data-testid="reader-next-chapter" disabled={!model.next?.available||navigating} onClick={()=>go(model.globalIndex+1)}>Следующая →</button></div>
   </article></div><footer className="reader-footer"><span>{navigating?'Открываем следующую часть…':online?'Чтение с сервера':'Локальное чтение'}</span><span>{model.globalIndex+1} / {model.totalChapters}</span><span role="status">{saveStatus}</span></footer>
 </div>;
}
