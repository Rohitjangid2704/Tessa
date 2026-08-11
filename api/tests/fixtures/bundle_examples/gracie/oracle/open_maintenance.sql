SELECT r.room_number AS room, count(*) AS open_issues
FROM smart_log_issue i
JOIN room r ON r.id = i.room_id
WHERE i.property_id = :tenant_id
  AND i.category = 'maintenance'
  AND i.status = 'open'
  AND i.created_at < :today
GROUP BY r.room_number
ORDER BY open_issues DESC, r.room_number
