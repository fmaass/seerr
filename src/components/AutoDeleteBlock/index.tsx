import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Modal from '@app/components/Common/Modal';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CalendarIcon, TrashIcon, ClockIcon } from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useIntl } from 'react-intl';
import { useState } from 'react';

const messages = defineMessages('components.AutoDeleteBlock', {
  autodelete: 'Auto-Delete',
  deletesin: 'Deletes in {days} {days, plural, one {day} other {days}}',
  deleteson: 'Scheduled for {date}',
  cancelautodelete: 'Cancel Auto-Delete',
  setautodelete: 'Set Auto-Delete',
  autodeletedays: 'Delete after (days)',
  autodeletedescription:
    'Media will be automatically removed from Radarr/Sonarr after the specified time period. Deletion check runs daily at 3:00 AM. Deleted items are added to the blocklist to prevent automatic re-requests.',
  confirmcancel: 'Are you sure you want to cancel auto-delete?',
  autodeleteactive: 'Auto-Delete Active',
  autodeletenotset: 'No auto-delete scheduled',
  setautodeletemodaltitle: 'Set Auto-Delete',
  expired: 'Expired - pending deletion',
});

interface AutoDeleteBlockProps {
  request: MediaRequest;
  onUpdate?: () => void;
}

const AutoDeleteBlock = ({ request, onUpdate }: AutoDeleteBlockProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const [showSetModal, setShowSetModal] = useState(false);
  const [autoDeleteDays, setAutoDeleteDays] = useState<number>(90);

  // Debug: Log request data on mount
  console.log('[AutoDeleteBlock] Request data:', {
    id: request.id,
    type: request.type,
    mediaId: request.media?.id,
    mediaTmdbId: request.media?.tmdbId,
    autoDeleteDate: request.autoDeleteDate,
  });

  // Calculate days remaining
  const getDaysRemaining = (): number | null => {
    if (!request.autoDeleteDate) return null;
    const now = new Date();
    const deleteDate = new Date(request.autoDeleteDate);
    const diffTime = deleteDate.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const getProgressPercentage = (): number => {
    if (!request.autoDeleteDate) return 0;
    
    const createdAt = new Date(request.createdAt);
    const deleteDate = new Date(request.autoDeleteDate);
    const now = new Date();
    
    const totalDuration = deleteDate.getTime() - createdAt.getTime();
    const elapsed = now.getTime() - createdAt.getTime();
    
    const percentage = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
    return percentage;
  };

  const cancelAutoDelete = async () => {
    console.log('[AutoDeleteBlock] Cancel button clicked');
    try {
      console.log('[AutoDeleteBlock] Sending POST to /api/v1/request/auto-delete/' + request.id);
      await axios.post(`/api/v1/request/auto-delete/${request.id}`, {
        days: 0,
      });
      console.log('[AutoDeleteBlock] Auto-delete cancelled successfully');
      
      // Refresh the page with cache-busting to force fresh data
      window.location.href = window.location.href.split('?')[0] + '?t=' + Date.now();
    } catch (error) {
      console.error('[AutoDeleteBlock] Failed to cancel auto-delete:', error);
      console.error('[AutoDeleteBlock] Error details:', error.response?.data);
      alert(`❌ Failed to cancel auto-delete: ${error.response?.data?.message || error.message}`);
    }
  };

  const setAutoDelete = async () => {
    console.log('[AutoDeleteBlock] Set button clicked, days:', autoDeleteDays);
    try {
      console.log('[AutoDeleteBlock] Sending POST to /api/v1/request/auto-delete/' + request.id);
      await axios.post(`/api/v1/request/auto-delete/${request.id}`, {
        days: autoDeleteDays,
      });
      console.log('[AutoDeleteBlock] Auto-delete set successfully');
      setShowSetModal(false);
      
      // Refresh the page with cache-busting to force fresh data
      window.location.href = window.location.href.split('?')[0] + '?t=' + Date.now();
    } catch (error) {
      console.error('[AutoDeleteBlock] Failed to set auto-delete:', error);
      console.error('[AutoDeleteBlock] Error details:', error.response?.data);
      alert(`❌ Failed to set auto-delete: ${error.response?.data?.message || error.message}`);
      setIsUpdating(false);
    }
  };

  const daysRemaining = getDaysRemaining();
  const progressPercentage = getProgressPercentage();
  const isExpired = daysRemaining !== null && daysRemaining < 0;

  return (
    <>
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center">
            <ClockIcon className="mr-2 h-5 w-5 text-yellow-500" />
            <span className="text-sm font-semibold">
              {intl.formatMessage(messages.autodelete)}
            </span>
          </div>
          {request.autoDeleteDate && (
            <Badge badgeType={isExpired ? 'danger' : 'warning'}>
              {intl.formatMessage(messages.autodeleteactive)}
            </Badge>
          )}
        </div>

        {request.autoDeleteDate ? (
          <>
            {/* Progress Bar */}
            <div className="relative mb-3 h-6 min-w-0 overflow-hidden rounded-full bg-gray-700">
              <div
                className={`h-6 transition-all duration-200 ease-in-out ${
                  isExpired ? 'bg-red-600' : 'bg-yellow-600'
                }`}
                style={{
                  width: `${progressPercentage}%`,
                }}
              />
              <div className="absolute inset-0 flex h-6 w-full items-center justify-center text-xs font-semibold">
                <span>
                  {isExpired
                    ? intl.formatMessage(messages.expired)
                    : daysRemaining !== null &&
                      intl.formatMessage(messages.deletesin, {
                        days: daysRemaining,
                      })}
                </span>
              </div>
            </div>

            {/* Delete Date */}
            <div className="mb-3 flex items-center justify-between text-xs text-gray-400">
              <div className="flex items-center">
                <CalendarIcon className="mr-1.5 h-4 w-4" />
                <span>
                  {intl.formatMessage(messages.deleteson, {
                    date: intl.formatDate(request.autoDeleteDate, {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: 'numeric',
                    }),
                  })}
                </span>
              </div>
            </div>

            {/* Cancel Button */}
            {hasPermission(Permission.MANAGE_REQUESTS) && (
              <ConfirmButton
                onClick={cancelAutoDelete}
                confirmText={intl.formatMessage(messages.confirmcancel)}
                className="w-full"
              >
                <TrashIcon />
                <span>{intl.formatMessage(messages.cancelautodelete)}</span>
              </ConfirmButton>
            )}
          </>
        ) : (
          <>
            {/* No Auto-Delete Set */}
            <div className="mb-3 text-xs text-gray-400">
              {intl.formatMessage(messages.autodeletenotset)}
            </div>

            {/* Set Auto-Delete Button */}
            {hasPermission(Permission.MANAGE_REQUESTS) && (
              <Button
                onClick={() => setShowSetModal(true)}
                className="w-full"
                buttonType="primary"
                disabled={isUpdating}
              >
                <CalendarIcon />
                <span>{intl.formatMessage(messages.setautodelete)}</span>
              </Button>
            )}
          </>
        )}
      </div>

      {/* Set Auto-Delete Modal */}
      {showSetModal && (
        <Modal
          title={intl.formatMessage(messages.setautodeletemodaltitle)}
          onCancel={() => setShowSetModal(false)}
          onOk={setAutoDelete}
          okText={intl.formatMessage(globalMessages.save)}
          okButtonType="primary"
          loading={isUpdating}
          backgroundClickable={false}
        >
          <div className="section">
            <div className="form-row">
              <label htmlFor="autoDeleteDays" className="text-label">
                {intl.formatMessage(messages.autodeletedays)}
                <span className="label-tip">
                  {intl.formatMessage(messages.autodeletedescription)}
                </span>
              </label>
              <div className="form-input-area">
                <select
                  id="autoDeleteDays"
                  value={autoDeleteDays}
                  onChange={(e) => setAutoDeleteDays(Number(e.target.value))}
                  className="rounded-md"
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                  <option value={180}>180 days</option>
                </select>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

export default AutoDeleteBlock;

