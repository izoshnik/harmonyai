import { supabaseRest, readProfileRole, isUnlimitedApiRole } from './auth.js';
const SOURCES=['Поиск в браузере','Друзья','Телеграмм','TikTok','YouTube','Реклама','Google','Яндекс','Социальные сети','Другое'];
const fail=(res,status,message)=>res.status(status).json({ok:false,error:{message}});
export async function recordMetric(userId,kind,amount=1,key=null){
 if(!userId)return;
 try{await supabaseRest('/rest/v1/hm_metric_events?on_conflict=user_id,event_key',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({user_id:userId,kind,amount,event_key:key}),timeoutMs:1500});}
 catch(e){console.warn('[metrics] event not recorded',e.code||e.status||'unavailable');}
}
export function periodStart(period,now=new Date()){
 const ms=now.getTime();
 if(period==='all')return null;
 if(period==='hour')return new Date(ms-3600000).toISOString();
 if(period==='day')return new Date(Math.floor((ms+10800000)/86400000)*86400000-10800000).toISOString();
 if(period==='week')return new Date(ms-7*86400000).toISOString();
 if(period==='month'){const d=new Date(ms),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-1);d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d.toISOString();}
 if(period==='year'){const d=new Date(ms),m=d.getUTCMonth();d.setUTCFullYear(d.getUTCFullYear()-1);if(d.getUTCMonth()!==m)d.setUTCDate(0);return d.toISOString();}
 throw new Error('invalid_period');
}
export async function handleStats(req,res,user,action,body){
 if(action==='stats.heartbeat'){
  if(req.method!=='POST')return fail(res,405,'Метод не поддерживается');
  const seconds=Math.min(60,Math.max(0,Math.floor(Number(body.seconds)||0)));
  await supabaseRest('/rest/v1/rpc/hm_heartbeat',{method:'POST',body:JSON.stringify({p_user:user.id,p_seconds:seconds})});return res.status(200).json({ok:true});
 }
 if(action==='stats.file'){
  if(req.method!=='POST')return fail(res,405,'Метод не поддерживается');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.eventId||''))return fail(res,400,'Некорректное событие');
  await recordMetric(user.id,'file_processed',1,body.eventId);return res.status(200).json({ok:true});
 }
 if(req.method!=='GET')return fail(res,405,'Метод не поддерживается');
 const admin=action==='stats.management';
 if(admin&&!isUnlimitedApiRole(await readProfileRole(user.id)))return fail(res,403,'Доступ только для Developer, Admin и Moderator');
 let since;try{since=periodStart(admin?String(req.query?.period||'week'):'all');}catch(e){return fail(res,400,'Неизвестный период');}
 try{const data=await supabaseRest('/rest/v1/rpc/hm_stats',{method:'POST',body:JSON.stringify({p_user:admin?null:user.id,p_since:since,p_until:new Date().toISOString()})});return res.status(200).json({ok:true,...data});}
 catch(e){console.warn('[stats]',e.code||e.status);return fail(res,503,'Статистика пока недоступна. Проверьте миграцию Beta 0.8.1 и подключение к базе.');}
}
export async function handleOnboarding(req,res,user,action,body){
 if(req.method!=='POST')return fail(res,405,'Метод не поддерживается');
 if(action==='survey.set'){
  const source=String(body.source||'').trim(),other=String(body.other||'').trim();
  if(!SOURCES.includes(source)||other.length>200||(source==='Другое'&&!other))return fail(res,400,'Выберите источник и заполните «Другое», если нужно');
  await supabaseRest('/rest/v1/rpc/hm_save_source',{method:'POST',body:JSON.stringify({p_user:user.id,p_source:source,p_other:source==='Другое'?other:null})});return res.status(200).json({ok:true});
 }
 const nickname=String(body.nickname||'').trim();
 if(!/^[A-Za-zÀ-ÿА-Яа-яЁё0-9 _.-]{2,30}$/u.test(nickname)||!/[A-Za-zÀ-ÿА-Яа-яЁё]/u.test(nickname))return fail(res,400,'Введите ник: 2–30 символов, хотя бы одна буква');
 try{const result=await supabaseRest('/rest/v1/rpc/hm_nickname',{method:'POST',body:JSON.stringify({p_user:user.id,p_nickname:nickname,p_save:action==='nickname.set'})});
  if(!result.available&&action==='nickname.set')return fail(res,409,'Этот ник уже занят');return res.status(200).json({ok:true,...result});
 }catch(e){return fail(res,503,'Не удалось сохранить ник. Попробуйте ещё раз позже.');}
}
