import { defineConfig } from 'vitest/config'

// Yalnız glob istifadə olunur. Vitest 3 `projects` içindəki LİTERAL (glob
// olmayan) yolu erkən həll edir və qovluq yoxdursa startup xətası atır —
// `apps/server` kimi yazsaydıq, o qovluq yaranana qədər test runner sınardı.
// Glob isə heç nəyə uyğun gəlməsə sadəcə boş qalır.
//
// `apps/web` də glob-a düşür, amma orada test faylı yoxdur (UI testləri bu
// fazada nəzərdə tutulmayıb) — vitest onu boş proyekt kimi keçir.
//
// QEYD: heç bir paket mövcud olmayanda vitest "No projects were found" xətası
// verir. Bu, yalnız `packages/shared` yaranana qədər davam edir.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
