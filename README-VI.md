# 9Router Rootless cho blitz.cloud

Mục tiêu của repo này là giữ nguyên 9Router upstream, chỉ bỏ entrypoint cần quyền root để chạy được trên blitz.cloud.

## Vì sao cần wrapper này?

Image 9Router upstream hiện có entrypoint chạy `chown` rồi `su-exec` khi container khởi động. blitz.cloud ép app chạy bằng UID/GID 1000, bỏ toàn bộ Linux capabilities, nên entrypoint đó bị dừng ngay.

Wrapper này:

- dùng image chính thức `decolua/9router:0.5.75`;
- chạy runtime bằng `1000:1000`;
- bỏ upstream `ENTRYPOINT`;
- khởi động trực tiếp `node custom-server.js`;
- giữ port `20128`;
- dùng `/app/data` làm dữ liệu bền vững;
- khai báo `VOLUME /app/data` để blitz.cloud nhận diện folder cần giữ;
- kiểm tra quyền ghi trước khi 9Router khởi động và in log dễ hiểu nếu volume bị sai quyền.

## A. Cách nhanh nhất: deploy từ public GitHub repo

### 1. Tạo repo GitHub mới

Ví dụ:

`9router-blitz-rootless`

Đặt repo là **Public**.

Upload toàn bộ các file trong thư mục này lên root của repo.

Không upload `.env.local` hoặc secret thật.

### 2. Trên blitz.cloud

Chọn:

`Host something new` → `My own code`

Dán URL public GitHub repo vừa tạo.

Blitz sẽ thấy `Dockerfile` và build nó.

### 3. Kiểm tra cấu hình trước khi Put it online

Port:

`20128`

Folder phải giữ giữa các lần restart:

`/app/data`

Environment variables:

```text
DATA_DIR=/app/data
PORT=20128
HOSTNAME=0.0.0.0
NODE_ENV=production
JWT_SECRET=<chuỗi-random-dài>
INITIAL_PASSWORD=<mật-khẩu-mạnh>
```

Nếu blitz tự nhận `VOLUME /app/data`, vẫn kiểm tra lại Advanced settings để chắc chắn giao diện hiển thị folder này là persistent/kept.

### 4. Deploy

Bấm `Put it online`.

Trong log, dòng đầu nên tương tự:

```text
[9router-rootless] uid=1000 gid=1000 data=/app/data port=20128 host=0.0.0.0
[9router-rootless] starting 9Router...
```

Sau đó mở URL `*.blitz.cloud` của app.

## B. Test local trước khi push

Yêu cầu Docker Desktop.

### PowerShell

```powershell
Copy-Item .env.example .env.local
# sửa JWT_SECRET + INITIAL_PASSWORD
.\test-local.ps1
```

Script chạy image gần giống sandbox của blitz.cloud:

- linux/amd64;
- UID 1000;
- drop toàn bộ capabilities;
- `no-new-privileges`;
- persistent Docker volume ở `/app/data`.

Mở:

`http://127.0.0.1:20128`

### Docker Compose

```powershell
Copy-Item .env.example .env.local
docker compose -f docker-compose.local.yml up --build
```

## C. Nếu Blitz vẫn báo lỗi

### Lỗi `DATA_DIR is not writable`

Nếu log có:

```text
[9router-rootless] ERROR: DATA_DIR is not writable ...
```

thì app rootless đã chạy đúng, nhưng persistent folder của Blitz chưa writable cho UID 1000.

Không đổi `DATA_DIR` sang `/tmp`, vì làm vậy restart sẽ mất account/config.

Chụp phần Logs + màn Advanced settings của persistent folder để xử lý tiếp.

### Lỗi không kết nối được port

Kiểm tra:

```text
PORT=20128
HOSTNAME=0.0.0.0
```

Blitz hiện không cho đổi port sau khi app đã tạo; nếu chọn sai port, xóa deployment sai và tạo lại.

## D. Nâng version 9Router sau này

Không dùng auto-update cho gateway chính.

Trong `Dockerfile`, đổi:

```dockerfile
ARG UPSTREAM_IMAGE=decolua/9router:0.5.75
```

sang tag mới đã kiểm tra, ví dụ:

```dockerfile
ARG UPSTREAM_IMAGE=decolua/9router:<TAG_MOI>
```

Commit → Blitz redeploy thủ công → kiểm tra account/API rồi mới coi là nâng cấp xong.

## E. Dữ liệu cần bảo vệ

9Router lưu dữ liệu dưới:

```text
/app/data/
  db/
    data.sqlite
    backups/
  ...
```

Không xóa persistent folder khi redeploy.

Hiện blitz.cloud chưa backup app files tự động, vì vậy khi hệ chạy ổn nên có cơ chế export/backup riêng cho `/app/data` nếu nền tảng cho phép.

## F. Mục tiêu sau khi deploy

Server Blitz chỉ chạy 9Router 24/7.

```text
Laptop:
Flowise + Repo Bridge + D:\zenwoo
        |
        v
9Router online trên Blitz
        |
        v
Antigravity / TRAE / SiliconFlow / provider khác
```

Không cần chuyển source code Zenwoo lên Blitz.
