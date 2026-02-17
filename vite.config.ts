import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/api/questions': {
                target: 'https://s3.us-east-1.amazonaws.com/qms.nagwa.com/questions',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api\/questions/, ''),
            },
        },
    },
})
