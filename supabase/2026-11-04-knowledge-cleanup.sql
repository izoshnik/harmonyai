-- ============================================================================
-- Очистка общей базы знаний (необязательно — код уже не берёт эти записи в
-- ответы; миграция просто наводит порядок в таблице). Ничего не удаляет:
-- записи выключаются (is_active=false) и их можно вернуть обратно.
-- ============================================================================

-- 1. «Developer note» — реплики разработчика из обычного чата («сделай фон
--    чёрным», «пиши от лица мужчины»…). В ответы пользователям больше не идут.
update public.knowledge_documents
   set is_active = false
 where is_active
   and source_type in ('note', 'developer_note');

-- 2. Дубли учебников: один и тот же файл загружали 2–3 раза (PDF и TXT,
--    повторные загрузки). Оставляем самый новый документ с тем же названием.
with ranked as (
  select id,
         row_number() over (
           partition by lower(regexp_replace(
             regexp_replace(title, '\.(pdf|txt|docx?|fb2|md|html?)$', '', 'i'),
             '[^a-zа-яё0-9]+', '', 'gi'))
           order by created_at desc
         ) as rn
    from public.knowledge_documents
   where is_active
     and scope = 'global'
     and source_type not in ('training', 'training_note')
)
update public.knowledge_documents d
   set is_active = false
  from ranked r
 where d.id = r.id
   and r.rn > 1;

-- Вернуть всё как было:
-- update public.knowledge_documents set is_active = true where source_type in ('note','developer_note');
