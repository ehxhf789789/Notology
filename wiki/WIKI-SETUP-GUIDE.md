# GitHub Wiki 등록 가이드

이 문서는 `wiki/` 폴더의 파일들을 GitHub Wiki에 등록하는 방법을 설명합니다.

---

## 방법 1: Git Clone (추천)

GitHub Wiki는 별도의 Git 저장소입니다. 클론해서 파일을 복사하면 가장 편합니다.

### 1단계: Wiki 활성화

1. GitHub 레포지토리 → **Settings** → **Features**
2. **Wikis** 체크박스 활성화
3. **Wiki** 탭으로 이동 → **Create the first page** 클릭 → 아무 내용 입력 후 저장

### 2단계: Wiki 저장소 클론

```bash
# 메인 레포 옆에 wiki 저장소 클론
cd ~/Desktop/Git
git clone https://github.com/YOUR_USERNAME/P01_Notology.wiki.git
```

### 3단계: 파일 복사

```bash
# wiki/ 폴더의 모든 파일을 wiki 저장소로 복사
cp -r P01_Notology/wiki/* P01_Notology.wiki/

# 구조 확인
ls P01_Notology.wiki/
# Home.md  _Sidebar.md  _Footer.md  images/  시작하기.md  EN-Getting-Started.md  ...
```

### 4단계: Push

```bash
cd P01_Notology.wiki
git add -A
git commit -m "Add full wiki documentation (KO + EN)"
git push
```

### 5단계: 확인

브라우저에서 `https://github.com/YOUR_USERNAME/P01_Notology/wiki` 접속하여 확인합니다.

---

## 방법 2: 웹 에디터 (복사 붙여넣기)

한 페이지씩 수동으로 등록하는 방법입니다.

### 페이지 생성 순서

1. GitHub → 레포지토리 → **Wiki** 탭
2. **New Page** 클릭
3. 페이지 이름 입력 (아래 표 참고)
4. 해당 `.md` 파일의 내용을 **복사 → 붙여넣기**
5. **Save Page** 클릭

### 페이지 이름 매핑

> ⚠️ **중요**: 페이지 이름을 정확히 입력해야 링크가 작동합니다!

| 파일명 | Wiki 페이지 이름 |
|--------|-----------------|
| `Home.md` | `Home` (자동 생성됨, 내용만 수정) |
| `_Sidebar.md` | `_Sidebar` |
| `_Footer.md` | `_Footer` |
| `시작하기.md` | `시작하기` |
| `화면-구성.md` | `화면-구성` |
| `사이드바.md` | `사이드바` |
| `호버-윈도우.md` | `호버-윈도우` |
| `노트-관리.md` | `노트-관리` |
| `에디터-기본.md` | `에디터-기본` |
| `에디터-고급.md` | `에디터-고급` |
| `위키링크.md` | `위키링크` |
| `캔버스.md` | `캔버스` |
| `검색.md` | `검색` |
| `그래프-뷰.md` | `그래프-뷰` |
| `캘린더.md` | `캘린더` |
| `문서-미리보기.md` | `문서-미리보기` |
| `템플릿.md` | `템플릿` |
| `태그.md` | `태그` |
| `설정.md` | `설정` |
| `단축키.md` | `단축키` |
| `볼트-동기화.md` | `볼트-동기화` |
| `팁과-트릭.md` | `팁과-트릭` |
| `EN-Getting-Started.md` | `EN-Getting-Started` |
| `EN-Interface-Overview.md` | `EN-Interface-Overview` |
| `EN-Sidebar-Explorer.md` | `EN-Sidebar-Explorer` |
| `EN-Hover-Windows.md` | `EN-Hover-Windows` |
| `EN-Note-Management.md` | `EN-Note-Management` |
| `EN-Editor-Basics.md` | `EN-Editor-Basics` |
| `EN-Editor-Advanced.md` | `EN-Editor-Advanced` |
| `EN-Wikilinks.md` | `EN-Wikilinks` |
| `EN-Canvas.md` | `EN-Canvas` |
| `EN-Search.md` | `EN-Search` |
| `EN-Graph-View.md` | `EN-Graph-View` |
| `EN-Calendar.md` | `EN-Calendar` |
| `EN-Document-Preview.md` | `EN-Document-Preview` |
| `EN-Templates.md` | `EN-Templates` |
| `EN-Tags.md` | `EN-Tags` |
| `EN-Settings.md` | `EN-Settings` |
| `EN-Keyboard-Shortcuts.md` | `EN-Keyboard-Shortcuts` |
| `EN-Vault-Sync.md` | `EN-Vault-Sync` |
| `EN-Tips-Tricks.md` | `EN-Tips-Tricks` |

### 등록 순서 (추천)

1. **Home** (기존 페이지 수정)
2. **_Sidebar** (사이드바 네비게이션)
3. **_Footer** (하단 푸터)
4. 한국어 페이지 19개 (위 표 순서대로)
5. 영어 페이지 19개 (위 표 순서대로)

---

## 이미지 업로드

### 방법 A: Git Clone 사용 시

`images/` 폴더째로 커밋하면 자동으로 업로드됩니다.

### 방법 B: 웹 에디터 사용 시

1. 아무 Wiki 페이지 편집 모드 진입
2. GIF 파일을 편집 영역으로 **드래그 앤 드롭**
3. 자동으로 업로드되고 URL이 생성됨
4. 해당 URL을 `![alt](URL)` 형태로 사용

또는 메인 리포의 이미지를 raw URL로 참조:
```
![alt](https://raw.githubusercontent.com/YOUR_USERNAME/P01_Notology/main/wiki/images/filename.gif)
```

---

## 특수 페이지 설명

| 파일 | 역할 |
|------|------|
| `Home.md` | Wiki 메인 페이지 (처음 접속 시 표시) |
| `_Sidebar.md` | 모든 페이지 왼쪽에 표시되는 네비게이션 |
| `_Footer.md` | 모든 페이지 하단에 표시되는 푸터 |

---

## 확인 체크리스트

- [ ] Home 페이지에서 모든 한국어 링크 클릭 → 정상 이동
- [ ] Home 페이지에서 모든 영어 링크 클릭 → 정상 이동
- [ ] _Sidebar가 모든 페이지에서 표시됨
- [ ] _Footer가 모든 페이지에서 표시됨
- [ ] 각 페이지의 상단/하단 네비게이션 링크 작동
- [ ] GIF 이미지가 정상 표시됨 (이미지 업로드 후)
