# Buttons for frontend

Use this example script to switch or toggle Pinyin, Hanzi (simplified <> traditional), and theme (light or dark).

Set Element ID to your buttons:
- #togglePinyin
- #toggleHanzi
- #toggleTheme

```javascript
document.getElementById('togglePinyin').addEventListener('click', function () {
  cidict.togglePinyin();
});
document.getElementById('toggleHanzi').addEventListener('click', function () {
  cidict.toggleHanzi();
});
document.getElementById('toggleTheme').addEventListener('click', function () {
  cidict.toggleTheme();
});
```
