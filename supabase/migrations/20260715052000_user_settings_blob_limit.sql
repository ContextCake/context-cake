alter table public.user_settings
add constraint user_settings_blob_size_check
check (octet_length(blob::text) <= 1000000);
