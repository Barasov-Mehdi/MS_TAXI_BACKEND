/** Sürücü sənədlərinin növləri (model və servis üçün ortaq). */
const DOC_TYPES = ['ID_FRONT', 'ID_BACK', 'LICENSE_FRONT', 'LICENSE_BACK', 'TECH_FRONT', 'TECH_BACK'];

const DOC_LABELS = {
  ID_FRONT: 'Şəxsiyyət vəsiqəsi (ön)',
  ID_BACK: 'Şəxsiyyət vəsiqəsi (arxa)',
  LICENSE_FRONT: 'Sürücülük vəsiqəsi (ön)',
  LICENSE_BACK: 'Sürücülük vəsiqəsi (arxa)',
  TECH_FRONT: 'Texniki pasport (ön)',
  TECH_BACK: 'Texniki pasport (arxa)',
};

module.exports = { DOC_TYPES, DOC_LABELS };
